#!/usr/bin/env python3
"""pi-ipython sidecar: owns one persistent IPython kernel via jupyter_client.

Speaks JSON-lines over stdio:

  request:  {"id": N, "method": "...", "params": {...}}
  response: {"id": N, "ok": true,  "result": {...}}
            {"id": N, "ok": false, "error": {"code": "...", "message": "..."}}
  event:    {"id": N, "event": "stream", "name": "stdout"|"stderr", "text": "..."}

Methods:
  ping              - liveness check
  start {cwd}       - spawn the kernel in `cwd` and run the bootstrap cell
  execute {code, timeout_ms, max_output_chars, record}
                    - run one cell; emits `stream` events, returns the final state
  interrupt         - interrupt the running cell via the control channel; handled
                      on the main thread so it can preempt an in-flight execute
  restart           - hard-restart the kernel (fresh namespace, keeps notebook cells)
  snapshot {path}   - dill-serialize the user namespace to `path` (per-variable)
  restore {path}    - revive a namespace written by `snapshot`
  export_ipynb {path} - write the recorded cells+outputs as an .ipynb
  shutdown          - stop the kernel and exit

Concurrency: the stdin loop runs on the main thread; kernel-bound requests
(start, execute, snapshot, restore, restart, export, shutdown) are serialized
on a worker thread. `interrupt` is the exception - it runs on the main thread
so it can preempt a cell that is stuck, matching the control-channel semantics
of the Jupyter protocol.
"""

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

from queue import Empty

ACQUIRE_TIMEOUT_S = (
    5.0  # how long a queued request waits before we report "kernel busy"
)
BUSY_AFTER_INTERRUPT_S = (
    5.0  # how long an interrupted cell may run before we declare it stuck
)
IOPUB_POLL_S = 0.2
DEFAULT_MAX_OUTPUT_CHARS = 65536
DEFAULT_SNAPSHOT_MAX_BYTES = 256 * 1024 * 1024
RESULT_MARKER = "__PI_IPYTHON_STATE__"


BOOTSTRAP_CELL = """
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


class KernelBusyError(Exception):
    """The kernel is still executing a previous cell (typically one that
    ignored an interrupt) and will not pick up new requests."""


class UsageError(Exception):
    """A request was made that the current sidecar state cannot serve."""


# ---- snapshot / restore cell sources ------------------------------------
#
# Both cells print exactly one RESULT_MARKER line carrying a JSON payload; the
# host parses that line out of the cell output. All builtins are reached through
# the `_b` alias so the helpers keep working even when the user namespace has
# shadowed names like list/open/print/len.


def build_snapshot_cell(path: str, max_bytes: int) -> str:
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
    ip = None
    try:
        ip = get_ipython()  # noqa: F821 (injected by IPython)
    except _b.Exception:
        ip = None
    ns = ip.user_ns if ip is not None else _b.globals()
    hidden = _b.set(_b.getattr(ip, "user_ns_hidden", {{}}) or {{}}) if ip is not None else _b.set()
    # Live/injected handles that the bootstrap recreates or that make no sense
    # to revive; user shadows of builtins (e.g. a variable named "list") are kept.
    always_skip = _b.set(["In", "Out", "get_ipython", "exit", "quit", "open"])
    payload = {{}}
    skipped = []
    total = 0
    for name in _b.list(ns.keys()):
        if name.startswith("_") or name in hidden or name in always_skip:
            continue
        value = ns[name]
        try:
            blob = dill.dumps(value)
        except _b.Exception as _err:
            skipped.append({{"name": name, "reason": _b.type(_err).__name__ + ": " + _b.str(_err)[:200]}})
            continue
        if _b.len(blob) > {max_bytes} or total + _b.len(blob) > {max_bytes}:
            skipped.append({{"name": name, "reason": "exceeds snapshot size cap"}})
            continue
        payload[name] = blob
        total += _b.len(blob)
    directory = os.path.dirname({path!r})
    if directory:
        os.makedirs(directory, exist_ok=True)
    tmp = {path!r} + ".tmp"
    try:
        with _b.open(tmp, "wb") as fh:
            dill.dump(payload, fh)
        os.replace(tmp, {path!r})
    except _b.Exception as _err:
        try:
            os.remove(tmp)
        except _b.Exception:
            pass
        _b.print({RESULT_MARKER!r} + json.dumps({{"error": "write failed: " + _b.str(_err)}}))
        return
    _b.print({RESULT_MARKER!r} + json.dumps({{"saved": _b.sorted(payload.keys()), "skipped": skipped, "bytes": os.path.getsize({path!r})}}))

_pi_ipython_snapshot_state()
""".strip()
        + "\n"
    )


def build_restore_cell(path: str) -> str:
    return (
        f"""
def _pi_ipython_restore_state():
    import builtins as _b, json
    restored, failed = [], []
    try:
        import dill
        with _b.open({path!r}, "rb") as fh:
            payload = dill.load(fh)
    except _b.Exception as _err:
        _b.print({RESULT_MARKER!r} + json.dumps({{"error": _b.str(_err)}}))
        return
    ip = None
    try:
        ip = get_ipython()  # noqa: F821
    except _b.Exception:
        ip = None
    ns = ip.user_ns if ip is not None else _b.globals()
    for name, blob in payload.items():
        try:
            ns[name] = dill.loads(blob)
            restored.append(name)
        except _b.Exception as _err:
            failed.append({{"name": name, "reason": _b.type(_err).__name__ + ": " + _b.str(_err)[:200]}})
    _b.print({RESULT_MARKER!r} + json.dumps({{"restored": restored, "failed": failed}}))

_pi_ipython_restore_state()
""".strip()
        + "\n"
    )


def _cap(buf: str, text: str, cap: int) -> tuple[str, bool]:
    """Append `text` to `buf`, never exceeding `cap` chars. Returns (buf, truncated)."""
    if cap <= 0:
        return buf + text, False
    room = cap - len(buf)
    if room <= 0:
        return buf, True
    if len(text) > room:
        return buf + text[:room], True
    return buf + text, False


def _empty_execution_result(status: str, cells: int) -> dict:
    return {
        "status": status,
        "stdout": "",
        "stderr": "",
        "result": "",
        "truncated": {"stdout": False, "stderr": False, "result": False},
        "duration_ms": 0,
        "cells": cells,
    }


class KernelSession:
    """One kernel plus the notebook cells recorded for it. All kernel access is
    serialized on the worker thread, except interrupt() which may be called from
    the main thread while a cell is running."""

    def __init__(self, cwd: str) -> None:
        self.cwd = cwd
        self.km = None
        self.kc = None
        self.started = False
        self.cells: list[dict] = []
        self.execution_count = 0
        self._interrupt_requested = threading.Event()
        self._unsettled_msg_id: str | None = None
        self._ipc_dir: tempfile.TemporaryDirectory[str] | None = None
        self._lock = threading.Lock()

    # -- lifecycle ---------------------------------------------------------

    def start(self) -> None:
        from jupyter_client import KernelManager

        try:
            with self._lock:
                self._interrupt_requested.clear()
                self._ipc_dir = tempfile.TemporaryDirectory(prefix="pi-ipython-")
                self.km = KernelManager(
                    kernel_name="python3",
                    cwd=self.cwd,
                    interrupt_mode="message",
                    transport="ipc",
                    ip=os.path.join(self._ipc_dir.name, "kernel"),
                )
                # Cell output arrives over IOPub. Kernel process logging is not
                # user output and would otherwise leak into the sidecar stderr.
                self.km.start_kernel(
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                self.kc = self.km.client()
                self.kc.start_channels()
                self.kc.wait_for_ready(timeout=60)
            # Set before the bootstrap so the bootstrap cell itself passes the
            # started guard in execute().
            self.started = True
            self._run_internal(BOOTSTRAP_CELL)
        except Exception:
            self._teardown()
            raise

    def _teardown(self) -> None:
        """Stop channels and shut down the kernel; never raises."""
        self.started = False
        self._unsettled_msg_id = None
        with self._lock:
            if self.kc is not None:
                try:
                    self.kc.stop_channels()
                except Exception:
                    pass
                self.kc = None
            if self.km is not None:
                try:
                    self.km.shutdown_kernel(now=True)
                except Exception:
                    pass
                self.km = None
            if self._ipc_dir is not None:
                try:
                    self._ipc_dir.cleanup()
                except Exception:
                    pass
                self._ipc_dir = None

    def restart(self) -> dict:
        self._teardown()
        self.start()
        return {"restarted": True}

    def shutdown(self) -> None:
        self._teardown()

    # -- interrupt (main thread; preempts a running cell) ------------------

    def _interrupt_kernel(self) -> None:
        """Interrupt the running cell, falling back to SIGINT; never raises."""
        with self._lock:
            km = self.km
        if km is None:
            return
        try:
            km.interrupt_kernel()
        except Exception:
            try:
                km.signal_kernel(signal.SIGINT)
            except Exception:
                pass

    def interrupt(self) -> dict:
        self._interrupt_requested.set()
        self._interrupt_kernel()
        return {"interrupted": True}

    def prepare_execute(self) -> None:
        """Clear cancellation before a request becomes the active execution."""
        self._interrupt_requested.clear()

    def _wait_for_unsettled_cell(self) -> None:
        """Wait briefly for a previously interrupted cell without queueing code."""
        if self._unsettled_msg_id is None or self.kc is None or self.km is None:
            return
        deadline = time.monotonic() + ACQUIRE_TIMEOUT_S
        interrupt_sent = False
        while time.monotonic() < deadline:
            if self._interrupt_requested.is_set() and not interrupt_sent:
                self._interrupt_kernel()
                interrupt_sent = True
            try:
                msg = self.kc.get_iopub_msg(timeout=IOPUB_POLL_S)
            except Empty:
                if not self.km.is_alive():
                    raise RuntimeError("IPython kernel exited during execution")
                continue
            if msg.get("parent_header", {}).get("msg_id") != self._unsettled_msg_id:
                continue
            if (
                msg.get("msg_type") == "status"
                and msg.get("content", {}).get("execution_state") == "idle"
            ):
                self._unsettled_msg_id = None
                return
        raise KernelBusyError(
            "the interrupted IPython cell is still running; wait and retry, "
            "or restart the kernel to start fresh"
        )

    # -- execute ------------------------------------------------------------

    def execute(
        self,
        code: str,
        timeout_ms: int = 0,
        max_output_chars: int = DEFAULT_MAX_OUTPUT_CHARS,
        record: bool = True,
        emit=None,
        prepared: bool = False,
    ) -> dict:
        if not self.started or self.km is None or self.kc is None:
            raise UsageError("kernel not started")
        if not prepared:
            self.prepare_execute()
        self._wait_for_unsettled_cell()
        if self._interrupt_requested.is_set():
            return _empty_execution_result("aborted", len(self.cells))
        msg_id = self.kc.execute(
            code, stop_on_error=False, store_history=True, allow_stdin=False
        )
        self._unsettled_msg_id = msg_id
        self.execution_count += 1
        count = self.execution_count

        started = time.monotonic()
        acquire_deadline = started + ACQUIRE_TIMEOUT_S
        deadline = (
            (started + timeout_ms / 1000.0) if timeout_ms and timeout_ms > 0 else None
        )
        busy_seen = False
        interrupt_requested_at: float | None = None
        status = "ok"
        stdout = stderr = result = ""
        trunc = {"stdout": False, "stderr": False, "result": False}
        error = None
        outputs: list[dict] = []
        notebook_chars = 0
        notebook_truncated = False

        def record_output(output: dict) -> None:
            nonlocal notebook_chars, notebook_truncated
            size = len(json.dumps(output, ensure_ascii=False))
            if max_output_chars <= 0 or notebook_chars + size <= max_output_chars:
                outputs.append(output)
                notebook_chars += size
            elif not notebook_truncated:
                outputs.append(
                    {
                        "output_type": "stream",
                        "name": "stderr",
                        "text": ["[notebook output truncated]\n"],
                    }
                )
                notebook_truncated = True

        while True:
            now = time.monotonic()
            if deadline is not None and now > deadline and busy_seen:
                self._interrupt_requested.set()
                self._interrupt_kernel()
                deadline = None
            if self._interrupt_requested.is_set():
                if interrupt_requested_at is None:
                    interrupt_requested_at = now
                    # An interrupt can race with request startup; send it again
                    # now that the execute message is definitely in flight.
                    self._interrupt_kernel()
                elif now - interrupt_requested_at > BUSY_AFTER_INTERRUPT_S:
                    raise KernelBusyError(
                        "the interrupted IPython cell did not stop; the kernel is stuck. "
                        "Wait and retry, or restart the kernel to start fresh"
                    )
            if not busy_seen and now > acquire_deadline:
                raise KernelBusyError(
                    "the IPython kernel is still running a previous cell and ignored the interrupt; "
                    "wait and retry, or restart the kernel to start fresh"
                )

            try:
                msg = self.kc.get_iopub_msg(timeout=IOPUB_POLL_S)
            except Empty:
                if not self.km.is_alive():
                    raise RuntimeError("IPython kernel exited during execution")
                continue
            if msg.get("parent_header", {}).get("msg_id") != msg_id:
                continue

            msg_type = msg.get("msg_type")
            content = msg.get("content", {})
            if msg_type == "status":
                state = content.get("execution_state")
                if state == "busy":
                    busy_seen = True
                elif state == "idle":
                    self._unsettled_msg_id = None
                    break
            elif msg_type == "stream":
                name = content.get("name", "stdout")
                text = content.get("text", "")
                if name == "stderr":
                    before = len(stderr)
                    stderr, t = _cap(stderr, text, max_output_chars)
                    accepted = stderr[before:]
                    trunc["stderr"] = trunc["stderr"] or t
                else:
                    before = len(stdout)
                    stdout, t = _cap(stdout, text, max_output_chars)
                    accepted = stdout[before:]
                    trunc["stdout"] = trunc["stdout"] or t
                if accepted:
                    record_output(
                        {"output_type": "stream", "name": name, "text": [accepted]}
                    )
                    if emit is not None:
                        emit({"event": "stream", "name": name, "text": accepted})
            elif msg_type == "execute_result":
                data = content.get("data", {})
                text = data.get("text/plain", "")
                before = len(result)
                result, t = _cap(result, text, max_output_chars)
                accepted = result[before:]
                trunc["result"] = trunc["result"] or t
                if accepted:
                    record_output(
                        {
                            "output_type": "execute_result",
                            "execution_count": count,
                            "data": {"text/plain": [accepted]},
                            "metadata": {},
                        }
                    )
            elif msg_type == "display_data":
                data = content.get("data", {})
                accepted = ""
                if "text/plain" in data:
                    text = data["text/plain"]
                    before = len(result)
                    result, t = _cap(result, text, max_output_chars)
                    accepted = result[before:]
                    trunc["result"] = trunc["result"] or t
                display_data = dict(data)
                if "text/plain" in display_data:
                    display_data["text/plain"] = accepted
                record_output(
                    {
                        "output_type": "display_data",
                        "data": display_data,
                        "metadata": content.get("metadata", {}),
                    }
                )
            elif msg_type == "error":
                error = {
                    "ename": content.get("ename", ""),
                    "evalue": content.get("evalue", ""),
                    "traceback": content.get("traceback", []),
                }
                status = "error"
                record_output({"output_type": "error", **error})

        duration_ms = int((time.monotonic() - started) * 1000)
        if self._interrupt_requested.is_set():
            status = "aborted"
        if record:
            self.cells.append(
                {
                    "cell_type": "code",
                    "execution_count": count,
                    "metadata": {},
                    "outputs": outputs,
                    "source": code.splitlines(keepends=True),
                }
            )
        result_payload = {
            "status": status,
            "stdout": stdout,
            "stderr": stderr,
            "result": result,
            "truncated": trunc,
            "duration_ms": duration_ms,
            "cells": len(self.cells),
        }
        if error is not None:
            result_payload["error"] = error
        return result_payload

    def _run_internal(self, code: str) -> dict:
        """Run a synthetic host cell (bootstrap/snapshot/restore): never recorded
        in the notebook, and errors raise instead of returning error payloads."""
        res = self.execute(code, record=False)
        if res["status"] == "error":
            err = res.get("error", {})
            raise RuntimeError(
                f"kernel cell failed: {err.get('ename', '')}: {err.get('evalue', '')}"
            )
        return res

    # -- state snapshot / restore -------------------------------------------

    def snapshot(self, path: str) -> dict:
        res = self._run_internal(build_snapshot_cell(path, DEFAULT_SNAPSHOT_MAX_BYTES))
        return self._parse_marker(res, "snapshot")

    def restore(self, path: str) -> dict:
        res = self._run_internal(build_restore_cell(path))
        return self._parse_marker(res, "restore")

    @staticmethod
    def _parse_marker(res: dict, kind: str) -> dict:
        for line in res.get("stdout", "").splitlines():
            if line.startswith(RESULT_MARKER):
                payload = json.loads(line[len(RESULT_MARKER) :])
                if "error" in payload:
                    raise RuntimeError(f"{kind} failed: {payload['error']}")
                return payload
        raise RuntimeError(
            f"{kind} produced no result marker; cell status={res.get('status')}"
        )

    # -- notebook export ------------------------------------------------------

    def export_ipynb(self, path: str) -> dict:
        # The notebook v4 format is plain JSON. Write its small subset directly
        # so a compatible kernel only needs Jupyter execution dependencies; in
        # particular, Prime Agent's managed kernel intentionally lacks nbformat.
        def to_output(output: dict) -> dict:
            result = dict(output)
            if result.get("output_type") == "stream":
                result["text"] = "".join(result.get("text", []))
            return result

        nb = {
            "nbformat": 4,
            # Cell IDs became required in minor version 5. Version 4 keeps this
            # intentionally small writer valid without inventing identifiers.
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
                    "outputs": [
                        to_output(output) for output in cell.get("outputs", [])
                    ],
                    "source": cell["source"],
                }
                for cell in self.cells
            ],
        }
        directory = os.path.dirname(path)
        if directory:
            os.makedirs(directory, exist_ok=True)
        tmp = path + ".tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(nb, fh, ensure_ascii=False, indent=1)
                fh.write("\n")
            os.replace(tmp, path)
        except Exception:
            try:
                os.remove(tmp)
            except OSError:
                pass
            raise
        return {"path": path, "cells": len(self.cells)}


# ---- stdio protocol -------------------------------------------------------


class Sidecar:
    def __init__(self) -> None:
        self.session: KernelSession | None = None
        self.kernel_queue: queue.Queue = queue.Queue()
        self.worker = threading.Thread(
            target=self._worker_loop, name="pi-ipython-kernel", daemon=True
        )
        self._send_lock = threading.Lock()
        self._execution_lock = threading.Lock()
        self._known_execution_ids: set[int] = set()
        self._cancelled_execution_ids: set[int] = set()
        self._running_execution_id: int | None = None

    def send(self, obj: dict) -> None:
        with self._send_lock:
            sys.stdout.write(json.dumps(obj) + "\n")
            sys.stdout.flush()

    def respond(self, req_id, payload: dict) -> None:
        self.send({"id": req_id, **payload})

    def _execute_request(self, req_id: int, params: dict, emit) -> dict:
        if self.session is None:
            raise UsageError("kernel not started")
        session = self.session

        with self._execution_lock:
            cancelled = req_id in self._cancelled_execution_ids
            self._cancelled_execution_ids.discard(req_id)
            if not cancelled:
                session.prepare_execute()
                self._running_execution_id = req_id

        if cancelled:
            with self._execution_lock:
                self._known_execution_ids.discard(req_id)
            return _empty_execution_result("aborted", len(session.cells))

        try:
            return session.execute(
                params.get("code", ""),
                timeout_ms=params.get("timeout_ms", 0) or 0,
                max_output_chars=params.get(
                    "max_output_chars", DEFAULT_MAX_OUTPUT_CHARS
                )
                or DEFAULT_MAX_OUTPUT_CHARS,
                record=params.get("record", True),
                emit=emit,
                prepared=True,
            )
        finally:
            with self._execution_lock:
                if self._running_execution_id == req_id:
                    self._running_execution_id = None
                self._known_execution_ids.discard(req_id)

    def _worker_loop(self) -> None:
        while True:
            item = self.kernel_queue.get()
            if item is None:
                if self.session is not None:
                    self.session.shutdown()
                return
            req_id, method, params, emit = item
            try:
                if method == "start":
                    if self.session is not None:
                        self.session.shutdown()
                    self.session = KernelSession(params.get("cwd") or os.getcwd())
                    self.session.start()
                    result = {"started": True}
                else:
                    if self.session is None:
                        raise UsageError("kernel not started")
                    session = self.session
                    if method == "execute":
                        result = self._execute_request(req_id, params, emit)
                    elif method == "snapshot":
                        result = session.snapshot(params["path"])
                    elif method == "restore":
                        result = session.restore(params["path"])
                    elif method == "export_ipynb":
                        result = session.export_ipynb(params["path"])
                    elif method == "restart":
                        result = session.restart()
                    elif method == "shutdown":
                        session.shutdown()
                        result = {"ok": True}
                    else:
                        raise UsageError(f"unknown kernel method {method!r}")
                self.respond(req_id, {"ok": True, "result": result})
            except KernelBusyError as err:
                self.respond(
                    req_id,
                    {
                        "ok": False,
                        "error": {"code": "kernel_busy", "message": str(err)},
                    },
                )
            except Exception as err:  # noqa: BLE001 - host-facing boundary
                self.respond(
                    req_id,
                    {"ok": False, "error": {"code": "error", "message": str(err)}},
                )
            if method == "shutdown":
                # The main thread stays blocked on stdin readline, so the only
                # way to actually terminate is to exit the process here. The
                # response is already flushed by send().
                os._exit(0)

    def handle(self, req: dict) -> None:
        req_id = req.get("id")
        method = req.get("method")
        params = req.get("params") or {}
        if method == "ping":
            self.respond(req_id, {"ok": True, "result": {"pong": True}})
            return
        if method == "interrupt":
            target = params.get("request_id")
            should_interrupt = target is None
            with self._execution_lock:
                if target is not None and target in self._known_execution_ids:
                    if target == self._running_execution_id:
                        should_interrupt = True
                    else:
                        self._cancelled_execution_ids.add(target)
                elif target is not None:
                    should_interrupt = False
            if self.session is None or not should_interrupt:
                self.respond(req_id, {"ok": True, "result": {"interrupted": False}})
                return
            try:
                self.respond(req_id, {"ok": True, "result": self.session.interrupt()})
            except Exception as err:
                self.respond(
                    req_id,
                    {"ok": False, "error": {"code": "error", "message": str(err)}},
                )
            return
        if method == "execute":
            with self._execution_lock:
                self._known_execution_ids.add(req_id)

            def emit(ev: dict) -> None:
                self.send({"id": req_id, **ev})

        else:
            emit = None
        self.kernel_queue.put((req_id, method, params, emit))

    def run(self) -> None:
        self.worker.start()
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                req = json.loads(line)
            except json.JSONDecodeError:
                continue
            self.handle(req)
        # stdin closed: shut down and exit.
        self.kernel_queue.put(None)
        self.worker.join(timeout=15)


def main() -> None:
    Sidecar().run()


if __name__ == "__main__":
    main()
