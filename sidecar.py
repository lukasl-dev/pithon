#!/usr/bin/env python3
"""Run an IPython kernel behind a small JSON-lines protocol."""

from __future__ import annotations

import json
import os
import queue
import signal
import subprocess
import sys
import tempfile
import threading
import time
from contextlib import suppress
from dataclasses import dataclass, field
from queue import Empty
from textwrap import dedent
from typing import Callable

ACQUIRE_TIMEOUT = 5.0
INTERRUPT_TIMEOUT = 5.0
POLL_INTERVAL = 0.2
DEFAULT_OUTPUT_LIMIT = 64 * 1024
SNAPSHOT_LIMIT = 256 * 1024 * 1024
RESULT_MARKER = "__PI_IPYTHON_STATE__"

BOOTSTRAP_CELL = dedent(
    """
    import os as _pi_ipython_os

    _pi_ipython_os.environ["NO_COLOR"] = "1"
    try:
        get_ipython().run_line_magic("colors", "nocolor")
    except Exception:
        try:
            get_ipython().colors = "nocolor"
        except Exception:
            pass

    try:
        import nest_asyncio as _pi_ipython_nest_asyncio
        _pi_ipython_nest_asyncio.apply()
    except Exception:
        pass
    """
).strip()


class KernelBusyError(Exception):
    pass


class UsageError(Exception):
    pass


def snapshot_cell(path: str, max_bytes: int) -> str:
    # This code runs inside the user's kernel. Builtins go through `_b` because
    # names such as `open` and `list` may have been reassigned by the user.
    return (
        f"""
def _pi_ipython_snapshot_state():
    import builtins as _b, json, os
    try:
        import dill
    except _b.Exception as _err:
        _b.print({RESULT_MARKER!r} + json.dumps({{"error": "dill unavailable: " + _b.str(_err)}}))
        return

    dill.settings["recurse"] = True
    try:
        ip = get_ipython()  # noqa: F821
    except _b.Exception:
        ip = None
    namespace = ip.user_ns if ip is not None else _b.globals()
    hidden = _b.set(_b.getattr(ip, "user_ns_hidden", {{}}) or {{}}) if ip is not None else _b.set()
    always_skip = _b.set(["In", "Out", "get_ipython", "exit", "quit", "open"])

    values = {{}}
    skipped = []
    total = 0
    for name in _b.list(namespace):
        if name.startswith("_") or name in hidden or name in always_skip:
            continue
        try:
            blob = dill.dumps(namespace[name])
        except _b.Exception as _err:
            skipped.append({{"name": name, "reason": _b.type(_err).__name__ + ": " + _b.str(_err)[:200]}})
            continue
        if _b.len(blob) > {max_bytes} or total + _b.len(blob) > {max_bytes}:
            skipped.append({{"name": name, "reason": "exceeds snapshot size cap"}})
            continue
        values[name] = blob
        total += _b.len(blob)

    directory = os.path.dirname({path!r})
    if directory:
        os.makedirs(directory, exist_ok=True)
    temporary = {path!r} + ".tmp"
    try:
        with _b.open(temporary, "wb") as file:
            dill.dump(values, file)
        os.replace(temporary, {path!r})
    except _b.Exception as _err:
        try:
            os.remove(temporary)
        except _b.Exception:
            pass
        _b.print({RESULT_MARKER!r} + json.dumps({{"error": "write failed: " + _b.str(_err)}}))
        return

    result = {{
        "saved": _b.sorted(values),
        "skipped": skipped,
        "bytes": os.path.getsize({path!r}),
    }}
    _b.print({RESULT_MARKER!r} + json.dumps(result))

_pi_ipython_snapshot_state()
""".strip()
        + "\n"
    )


def restore_cell(path: str) -> str:
    return (
        f"""
def _pi_ipython_restore_state():
    import builtins as _b, json
    try:
        import dill
        with _b.open({path!r}, "rb") as file:
            values = dill.load(file)
    except _b.Exception as _err:
        _b.print({RESULT_MARKER!r} + json.dumps({{"error": _b.str(_err)}}))
        return

    try:
        ip = get_ipython()  # noqa: F821
    except _b.Exception:
        ip = None
    namespace = ip.user_ns if ip is not None else _b.globals()
    restored = []
    failed = []
    for name, blob in values.items():
        try:
            namespace[name] = dill.loads(blob)
            restored.append(name)
        except _b.Exception as _err:
            failed.append({{"name": name, "reason": _b.type(_err).__name__ + ": " + _b.str(_err)[:200]}})

    _b.print({RESULT_MARKER!r} + json.dumps({{"restored": restored, "failed": failed}}))

_pi_ipython_restore_state()
""".strip()
        + "\n"
    )


def append_limited(current: str, text: str, limit: int) -> tuple[str, bool]:
    if limit <= 0:
        return current + text, False
    remaining = limit - len(current)
    if remaining <= 0:
        return current, True
    return current + text[:remaining], len(text) > remaining


def empty_result(status: str, cells: int) -> dict:
    return {
        "status": status,
        "stdout": "",
        "stderr": "",
        "result": "",
        "truncated": {"stdout": False, "stderr": False, "result": False},
        "duration_ms": 0,
        "cells": cells,
    }


@dataclass
class OutputCapture:
    limit: int
    stdout: str = ""
    stderr: str = ""
    result: str = ""
    truncated: dict[str, bool] = field(
        default_factory=lambda: {"stdout": False, "stderr": False, "result": False}
    )
    notebook_outputs: list[dict] = field(default_factory=list)
    _notebook_chars: int = 0
    _notebook_truncated: bool = False

    def _append(self, name: str, text: str) -> str:
        current = getattr(self, name)
        updated, truncated = append_limited(current, text, self.limit)
        setattr(self, name, updated)
        self.truncated[name] |= truncated
        return updated[len(current) :]

    def _record(self, output: dict) -> None:
        size = len(json.dumps(output, ensure_ascii=False))
        if self.limit <= 0 or self._notebook_chars + size <= self.limit:
            self.notebook_outputs.append(output)
            self._notebook_chars += size
        elif not self._notebook_truncated:
            self.notebook_outputs.append(
                {
                    "output_type": "stream",
                    "name": "stderr",
                    "text": ["[notebook output truncated]\n"],
                }
            )
            self._notebook_truncated = True

    def stream(self, name: str, text: str) -> str:
        name = "stderr" if name == "stderr" else "stdout"
        accepted = self._append(name, text)
        if accepted:
            self._record({"output_type": "stream", "name": name, "text": [accepted]})
        return accepted

    def execution_result(self, text: str, count: int) -> None:
        accepted = self._append("result", text)
        if accepted:
            self._record(
                {
                    "output_type": "execute_result",
                    "execution_count": count,
                    "data": {"text/plain": [accepted]},
                    "metadata": {},
                }
            )

    def display(self, data: dict, metadata: dict) -> None:
        data = dict(data)
        if "text/plain" in data:
            data["text/plain"] = self._append("result", data["text/plain"])
        self._record(
            {"output_type": "display_data", "data": data, "metadata": metadata}
        )

    def error(self, content: dict) -> dict:
        error = {
            "ename": content.get("ename", ""),
            "evalue": content.get("evalue", ""),
            "traceback": content.get("traceback", []),
        }
        self._record({"output_type": "error", **error})
        return error


class KernelSession:
    """The live kernel and the notebook cells recorded from it."""

    def __init__(self, cwd: str) -> None:
        self.cwd = cwd
        self.manager = None
        self.client = None
        self.started = False
        self.cells: list[dict] = []
        self.execution_count = 0
        self._interrupt_requested = threading.Event()
        self._unfinished_message: str | None = None
        self._ipc_directory: tempfile.TemporaryDirectory[str] | None = None
        self._kernel_lock = threading.Lock()

    def start(self) -> None:
        from jupyter_client import KernelManager

        try:
            with self._kernel_lock:
                self._interrupt_requested.clear()
                self._ipc_directory = tempfile.TemporaryDirectory(prefix="pi-ipython-")
                self.manager = KernelManager(
                    kernel_name="python3",
                    cwd=self.cwd,
                    interrupt_mode="message",
                    transport="ipc",
                    ip=os.path.join(self._ipc_directory.name, "kernel"),
                )
                self.manager.start_kernel(
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                self.client = self.manager.client()
                self.client.start_channels()
                self.client.wait_for_ready(timeout=60)
            self.started = True
            self._run_internal(BOOTSTRAP_CELL)
        except Exception:
            self._teardown()
            raise

    def _teardown(self) -> None:
        self.started = False
        self._unfinished_message = None
        with self._kernel_lock:
            if self.client is not None:
                with suppress(Exception):
                    self.client.stop_channels()
                self.client = None
            if self.manager is not None:
                with suppress(Exception):
                    self.manager.shutdown_kernel(now=True)
                self.manager = None
            if self._ipc_directory is not None:
                with suppress(Exception):
                    self._ipc_directory.cleanup()
                self._ipc_directory = None

    def restart(self) -> dict:
        self._teardown()
        self.start()
        return {"restarted": True}

    def shutdown(self) -> None:
        self._teardown()

    def _interrupt_kernel(self) -> None:
        with self._kernel_lock:
            manager = self.manager
        if manager is None:
            return
        try:
            manager.interrupt_kernel()
        except Exception:
            with suppress(Exception):
                manager.signal_kernel(signal.SIGINT)

    def interrupt(self) -> dict:
        self._interrupt_requested.set()
        self._interrupt_kernel()
        return {"interrupted": True}

    def prepare_execute(self) -> None:
        self._interrupt_requested.clear()

    def _finish_interrupted_cell(self) -> None:
        """Drain an earlier cell until it becomes idle, without submitting code."""
        if (
            self._unfinished_message is None
            or self.client is None
            or self.manager is None
        ):
            return

        deadline = time.monotonic() + ACQUIRE_TIMEOUT
        interrupt_sent = False
        while time.monotonic() < deadline:
            if self._interrupt_requested.is_set() and not interrupt_sent:
                self._interrupt_kernel()
                interrupt_sent = True
            try:
                message = self.client.get_iopub_msg(timeout=POLL_INTERVAL)
            except Empty:
                if not self.manager.is_alive():
                    raise RuntimeError("IPython kernel exited during execution")
                continue
            if not self._belongs_to(message, self._unfinished_message):
                continue
            if self._is_idle(message):
                self._unfinished_message = None
                return

        raise KernelBusyError(
            "the interrupted IPython cell is still running; wait and retry, "
            "or restart the kernel to start fresh"
        )

    @staticmethod
    def _belongs_to(message: dict, message_id: str) -> bool:
        return message.get("parent_header", {}).get("msg_id") == message_id

    @staticmethod
    def _is_idle(message: dict) -> bool:
        return (
            message.get("msg_type") == "status"
            and message.get("content", {}).get("execution_state") == "idle"
        )

    def execute(
        self,
        code: str,
        timeout_ms: int = 0,
        max_output_chars: int = DEFAULT_OUTPUT_LIMIT,
        record: bool = True,
        emit: Callable[[dict], None] | None = None,
        prepared: bool = False,
    ) -> dict:
        if not self.started or self.manager is None or self.client is None:
            raise UsageError("kernel not started")
        if not prepared:
            self.prepare_execute()

        self._finish_interrupted_cell()
        if self._interrupt_requested.is_set():
            return empty_result("aborted", len(self.cells))

        message_id = self.client.execute(
            code, stop_on_error=False, store_history=True, allow_stdin=False
        )
        self._unfinished_message = message_id
        self.execution_count += 1
        count = self.execution_count

        started_at = time.monotonic()
        acquire_deadline = started_at + ACQUIRE_TIMEOUT
        execution_deadline = (
            started_at + timeout_ms / 1000 if timeout_ms and timeout_ms > 0 else None
        )
        became_busy = False
        interrupted_at: float | None = None
        status = "ok"
        capture = OutputCapture(max_output_chars)
        error = None

        while True:
            now = time.monotonic()
            if (
                execution_deadline is not None
                and now > execution_deadline
                and became_busy
            ):
                self._interrupt_requested.set()
                self._interrupt_kernel()
                execution_deadline = None

            if self._interrupt_requested.is_set():
                if interrupted_at is None:
                    interrupted_at = now
                    # The first interrupt may have raced with execute_request.
                    self._interrupt_kernel()
                elif now - interrupted_at > INTERRUPT_TIMEOUT:
                    raise KernelBusyError(
                        "the interrupted IPython cell did not stop; the kernel is stuck. "
                        "Wait and retry, or restart the kernel to start fresh"
                    )

            if not became_busy and now > acquire_deadline:
                raise KernelBusyError(
                    "the IPython kernel is still running a previous cell and ignored "
                    "the interrupt; wait and retry, or restart the kernel to start fresh"
                )

            try:
                message = self.client.get_iopub_msg(timeout=POLL_INTERVAL)
            except Empty:
                if not self.manager.is_alive():
                    raise RuntimeError("IPython kernel exited during execution")
                continue
            if not self._belongs_to(message, message_id):
                continue

            message_type = message.get("msg_type")
            content = message.get("content", {})
            if message_type == "status":
                state = content.get("execution_state")
                if state == "busy":
                    became_busy = True
                elif state == "idle":
                    self._unfinished_message = None
                    break
            elif message_type == "stream":
                name = "stderr" if content.get("name") == "stderr" else "stdout"
                accepted = capture.stream(name, content.get("text", ""))
                if accepted and emit is not None:
                    emit({"event": "stream", "name": name, "text": accepted})
            elif message_type == "execute_result":
                capture.execution_result(
                    content.get("data", {}).get("text/plain", ""), count
                )
            elif message_type == "display_data":
                capture.display(content.get("data", {}), content.get("metadata", {}))
            elif message_type == "error":
                error = capture.error(content)
                status = "error"

        if self._interrupt_requested.is_set():
            status = "aborted"
        if record:
            self.cells.append(
                {
                    "cell_type": "code",
                    "execution_count": count,
                    "metadata": {},
                    "outputs": capture.notebook_outputs,
                    "source": code.splitlines(keepends=True),
                }
            )

        result = {
            "status": status,
            "stdout": capture.stdout,
            "stderr": capture.stderr,
            "result": capture.result,
            "truncated": capture.truncated,
            "duration_ms": int((time.monotonic() - started_at) * 1000),
            "cells": len(self.cells),
        }
        if error is not None:
            result["error"] = error
        return result

    def _run_internal(self, code: str) -> dict:
        result = self.execute(code, record=False)
        if result["status"] == "error":
            error = result.get("error", {})
            raise RuntimeError(
                f"kernel cell failed: {error.get('ename', '')}: "
                f"{error.get('evalue', '')}"
            )
        return result

    def snapshot(self, path: str) -> dict:
        result = self._run_internal(snapshot_cell(path, SNAPSHOT_LIMIT))
        return self._marker_result(result, "snapshot")

    def restore(self, path: str) -> dict:
        result = self._run_internal(restore_cell(path))
        return self._marker_result(result, "restore")

    @staticmethod
    def _marker_result(result: dict, operation: str) -> dict:
        for line in result.get("stdout", "").splitlines():
            if not line.startswith(RESULT_MARKER):
                continue
            payload = json.loads(line.removeprefix(RESULT_MARKER))
            if "error" in payload:
                raise RuntimeError(f"{operation} failed: {payload['error']}")
            return payload
        raise RuntimeError(
            f"{operation} produced no result marker; cell status={result.get('status')}"
        )

    def export_ipynb(self, path: str) -> dict:
        def notebook_output(output: dict) -> dict:
            output = dict(output)
            if output.get("output_type") == "stream":
                output["text"] = "".join(output.get("text", []))
            return output

        notebook = {
            "nbformat": 4,
            "nbformat_minor": 4,
            "metadata": {
                "kernelspec": {
                    "display_name": "Python 3",
                    "language": "python",
                    "name": "python3",
                },
                "language_info": {"name": "python", "version": "3"},
            },
            "cells": [
                {
                    "cell_type": "code",
                    "execution_count": cell.get("execution_count"),
                    "metadata": {},
                    "outputs": [notebook_output(item) for item in cell["outputs"]],
                    "source": cell["source"],
                }
                for cell in self.cells
            ],
        }
        directory = os.path.dirname(path)
        if directory:
            os.makedirs(directory, exist_ok=True)
        temporary = path + ".tmp"
        try:
            with open(temporary, "w", encoding="utf-8") as file:
                json.dump(notebook, file, ensure_ascii=False, indent=1)
                file.write("\n")
            os.replace(temporary, path)
        except Exception:
            with suppress(OSError):
                os.remove(temporary)
            raise
        return {"path": path, "cells": len(self.cells)}


@dataclass
class Request:
    id: int
    method: str
    params: dict
    emit: Callable[[dict], None] | None = None


class Sidecar:
    def __init__(self) -> None:
        self.session: KernelSession | None = None
        self.requests: queue.Queue[Request | None] = queue.Queue()
        self._send_lock = threading.Lock()
        self._execution_lock = threading.Lock()
        self._known_executions: set[int] = set()
        self._cancelled_executions: set[int] = set()
        self._running_execution: int | None = None

    def send(self, message: dict) -> None:
        with self._send_lock:
            print(json.dumps(message), flush=True)

    def respond(self, request_id: int, **payload: object) -> None:
        self.send({"id": request_id, **payload})

    def _execute(self, request: Request) -> dict:
        if self.session is None:
            raise UsageError("kernel not started")
        session = self.session

        with self._execution_lock:
            cancelled = request.id in self._cancelled_executions
            self._cancelled_executions.discard(request.id)
            if not cancelled:
                session.prepare_execute()
                self._running_execution = request.id

        if cancelled:
            with self._execution_lock:
                self._known_executions.discard(request.id)
            return empty_result("aborted", len(session.cells))

        try:
            return session.execute(
                request.params.get("code", ""),
                timeout_ms=request.params.get("timeout_ms", 0) or 0,
                max_output_chars=request.params.get(
                    "max_output_chars", DEFAULT_OUTPUT_LIMIT
                )
                or DEFAULT_OUTPUT_LIMIT,
                record=request.params.get("record", True),
                emit=request.emit,
                prepared=True,
            )
        finally:
            with self._execution_lock:
                if self._running_execution == request.id:
                    self._running_execution = None
                self._known_executions.discard(request.id)

    def _run_request(self, request: Request) -> dict:
        method = request.method
        if method == "start":
            if self.session is not None:
                self.session.shutdown()
            self.session = KernelSession(request.params.get("cwd") or os.getcwd())
            self.session.start()
            return {"started": True}

        if self.session is None:
            raise UsageError("kernel not started")
        if method == "execute":
            return self._execute(request)
        if method == "snapshot":
            return self.session.snapshot(request.params["path"])
        if method == "restore":
            return self.session.restore(request.params["path"])
        if method == "export_ipynb":
            return self.session.export_ipynb(request.params["path"])
        if method == "restart":
            return self.session.restart()
        if method == "shutdown":
            self.session.shutdown()
            return {"ok": True}
        raise UsageError(f"unknown kernel method {method!r}")

    def _worker(self) -> None:
        while True:
            request = self.requests.get()
            if request is None:
                break
            try:
                result = self._run_request(request)
                self.respond(request.id, ok=True, result=result)
            except KernelBusyError as error:
                self.respond(
                    request.id,
                    ok=False,
                    error={"code": "kernel_busy", "message": str(error)},
                )
            except Exception as error:
                self.respond(
                    request.id,
                    ok=False,
                    error={"code": "error", "message": str(error)},
                )
            if request.method == "shutdown":
                return

        if self.session is not None:
            self.session.shutdown()

    def _interrupt(self, request_id: int, params: dict) -> None:
        target = params.get("request_id")
        should_interrupt = target is None
        with self._execution_lock:
            if target is not None and target in self._known_executions:
                if target == self._running_execution:
                    should_interrupt = True
                else:
                    self._cancelled_executions.add(target)
            elif target is not None:
                should_interrupt = False

        if self.session is None or not should_interrupt:
            self.respond(request_id, ok=True, result={"interrupted": False})
            return
        try:
            self.respond(request_id, ok=True, result=self.session.interrupt())
        except Exception as error:
            self.respond(
                request_id,
                ok=False,
                error={"code": "error", "message": str(error)},
            )

    def handle(self, message: dict) -> None:
        request_id = message.get("id")
        method = message.get("method")
        params = message.get("params") or {}

        if method == "ping":
            self.respond(request_id, ok=True, result={"pong": True})
            return
        if method == "interrupt":
            self._interrupt(request_id, params)
            return

        emit = None
        if method == "execute":
            with self._execution_lock:
                self._known_executions.add(request_id)

            def emit(event: dict) -> None:
                self.send({"id": request_id, **event})

        self.requests.put(Request(request_id, method, params, emit))

    def _read_stdin(self) -> None:
        for line in sys.stdin:
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            self.handle(message)
        self.requests.put(None)

    def run(self) -> None:
        # Reading happens on a daemon thread so a clean shutdown does not need
        # to force the process out while that thread is blocked in readline().
        reader = threading.Thread(
            target=self._read_stdin, name="sidecar-stdin", daemon=True
        )
        reader.start()
        self._worker()


def main() -> None:
    Sidecar().run()


if __name__ == "__main__":
    main()
