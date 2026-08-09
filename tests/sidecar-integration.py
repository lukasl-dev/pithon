#!/usr/bin/env python3
"""Black-box integration test for the pi-ipython JSON-lines sidecar protocol."""

from __future__ import annotations

import json
import os
from pathlib import Path
import select
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
SIDECAR = ROOT / "ipython" / "sidecar.py"
PYTHON = os.environ.get("PI_IPYTHON_PYTHON", sys.executable)


def start(cwd: Path) -> subprocess.Popen[str]:
    return subprocess.Popen(
        [PYTHON, "-u", str(SIDECAR)],
        cwd=cwd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )


def request(
    proc: subprocess.Popen[str],
    request_id: int,
    method: str,
    *,
    response_timeout: float = 30,
    **params,
):
    assert proc.stdin and proc.stdout
    proc.stdin.write(
        json.dumps({"id": request_id, "method": method, "params": params}) + "\n"
    )
    proc.stdin.flush()
    deadline = time.monotonic() + response_timeout
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([proc.stdout], [], [], remaining)[0]:
            raise AssertionError(f"timed out waiting for response to {method}")
        line = proc.stdout.readline()
        if not line:
            break
        message = json.loads(line)
        if message.get("id") == request_id and "ok" in message:
            assert message["ok"], message
            return message["result"]
    stderr = proc.stderr.read() if proc.stderr else ""
    raise AssertionError(f"sidecar exited before response to {method}: {stderr}")


def shutdown(proc: subprocess.Popen[str], request_id: int) -> None:
    try:
        request(proc, request_id, "shutdown")
    finally:
        proc.wait(timeout=15)
        stderr = proc.stderr.read() if proc.stderr else ""
        assert not stderr, f"unexpected sidecar stderr: {stderr}"


def main() -> None:
    if not shutil.which(Path(PYTHON).name) and not Path(PYTHON).exists():
        raise SystemExit(f"Python not found: {PYTHON}")

    with tempfile.TemporaryDirectory(prefix="pi-ipython-test-") as temporary:
        cwd = Path(temporary)
        snapshot = "state.dill"
        notebook = "notebook.ipynb"
        snapshot_path = cwd / snapshot
        notebook_path = cwd / notebook

        first = start(cwd)
        try:
            assert request(first, 1, "ping")["pong"] is True
            assert request(first, 2, "start", cwd=str(cwd))["started"] is True
            executed = request(
                first,
                3,
                "execute",
                code="numbers = [2, 3, 5]\nsum(numbers)",
                max_output_chars=65536,
            )
            assert executed["status"] == "ok", executed
            assert executed["result"] == "10", executed
            saved = request(first, 4, "snapshot", path=snapshot)
            assert "numbers" in saved["saved"], saved
            exported = request(first, 5, "export_ipynb", path=notebook)
            assert exported["cells"] == 1, exported
            assert snapshot_path.is_file() and notebook_path.is_file()
            exported_notebook = json.loads(notebook_path.read_text())
            assert exported_notebook["nbformat"] == 4, exported_notebook
            assert exported_notebook["cells"][0]["source"] == [
                "numbers = [2, 3, 5]\n",
                "sum(numbers)",
            ], exported_notebook
            assert request(first, 6, "restart")["restarted"] is True
            restarted = request(first, 7, "execute", code="'numbers' in globals()")
            assert restarted["result"] == "False", restarted
            timed_out = request(
                first,
                8,
                "execute",
                code="import time; time.sleep(30)",
                timeout_ms=100,
            )
            assert timed_out["status"] == "aborted", timed_out
        finally:
            shutdown(first, 9)

        second = start(cwd)
        try:
            request(second, 10, "start", cwd=str(cwd))
            empty_notebook = "empty.ipynb"
            exported = request(second, 11, "export_ipynb", path=empty_notebook)
            assert exported["cells"] == 0, exported
            empty = json.loads((cwd / empty_notebook).read_text())
            assert empty["cells"] == [], empty
            assert empty["nbformat_minor"] == 4, empty
            restored = request(second, 12, "restore", path=snapshot)
            assert "numbers" in restored["restored"], restored
            executed = request(
                second,
                13,
                "execute",
                code="sum(numbers)",
                max_output_chars=65536,
            )
            assert executed["result"] == "10", executed
        finally:
            shutdown(second, 14)

    print("pi-ipython sidecar integration: PASS")


if __name__ == "__main__":
    main()
