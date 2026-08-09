# pi-ipython

## Goal

Bring Prime Agent's useful *programmatic notebook* interaction model to Pi:
make one persistent Python/IPython kernel the agent's normal control surface.
It should be able to retain intermediate state instead of repeatedly placing
large search results, parsed inputs, or helper code in the model context.

A coding task becomes a sequence such as:

```python
from pathlib import Path

sources = list(Path("src").rglob("*.ts"))
large_sources = [p for p in sources if p.stat().st_size > 20_000]
```

followed later by a cell that reuses `sources` and `large_sources`. File
reads, rewrites, shell commands, testing, and data transformation are ordinary
Python or `%%bash` cells rather than separate model tools.

## Scope: first implementation

This prototype deliberately implements the notebook part, not Prime's daemon,
RLM sub-agents, schedules, or Python skill bridge:

- **One `ipython` tool.** Its one parameter is `code`.
- **One kernel per Pi runtime and working directory.** Calls are serialized;
  all Python cells share one namespace.
- **Persistent project notebook state.** Pi's session directory is already
  scoped by cwd, so artifacts live at
  `~/.pi/agent/sessions/--<escaped-cwd>--/pi-ipython/`:
  - `kernel-state.dill` is a best-effort namespace snapshot;
  - `kernel-notebook.ipynb` is an export of executed user cells and outputs.
- **Safe-enough lifecycle.** The sidecar starts lazily, an abort interrupts the
  current cell rather than discarding the namespace, and shutdown snapshots,
  exports, then terminates the kernel.
- **Notebook-first tool surface.** On session startup the extension removes
  Pi's built-in `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls` tools.
  This shrinks the tool schema and makes the model use the retained kernel.
  Set `PI_IPYTHON_KEEP_BUILTINS=1` to retain Pi's normal tools for comparison
  or an escape hatch.

Other extension tools are intentionally left active. Use `pi --no-builtin-tools`
when testing the same mode explicitly from the CLI.

## Architecture

```text
Pi `ipython` tool (TypeScript)
  └─ PiIPythonClient — JSON-lines RPC, cancellation → interrupt
       └─ sidecar.py — owns a Jupyter client and serializes kernel operations
            └─ IPython kernel — Python namespace and executed notebook cells
```

The Python sidecar exists because Jupyter's ZeroMQ protocol, IOPub streaming,
and control-channel interrupts are substantially more reliable than trying to
emulate an interactive Python REPL from Node. It communicates with its parent
over stdio and with the local kernel through private Unix IPC sockets. No TCP
listener is opened.

The extension creates its own lightweight kernel venv under
`~/.cache/pi-ipython/kernel-venv` on first use (via `uv`) rather than depending
on a Prime installation. For a direct comparison with Prime Agent, point it at
Prime's managed environment:

```bash
PI_IPYTHON_PYTHON="$HOME/.prime/agent/kernel-venv/bin/python" pi
```

`PI_IPYTHON_PYTHON` must resolve to a Python environment containing
`ipykernel`, `jupyter_client`, `dill`, and `nest-asyncio`. Notebook v4 JSON is
written directly, so `nbformat` is deliberately not a kernel dependency.

## Agent doctrine

The extension appends concise, explicit instructions to Pi's system prompt:
use Python variables for reusable results, use `%%bash` only as the first line
of a shell cell, and execute a project's own tooling through its own
environment. The last point prevents accidentally importing a project's
packages into the kernel venv just because they are available to the project.

This is important for the token objective: state is kept in Python names; tool
outputs can be summarized or selected before returning to the model. The
kernel output is capped at 64 KiB per stream/result field, and the agent should
store large data in named values or files rather than print it.

## Decisions and trade-offs

1. **State is scoped by cwd, not conversation tree.** A `/new` or `/resume`
   in the same project can restore the latest settled snapshot. This is the
   closest useful analogue to Prime's per-directory notebook, but it means a
   kernel snapshot is shared by branches. It is working context, not a
   branch-correct source of truth.
2. **Snapshot per value.** `dill` failures for open sockets, processes, C
   extensions, and live tasks do not invalidate the rest of the namespace;
   skipped values are reported. Because values are serialized independently,
   identity shared between two top-level names is not guaranteed after restore.
   Snapshots are capped at 256 MiB.
3. **IPython notebook export is an audit/debug artifact.** It is exported at
   shutdown and on `/kernel export`; it is not replayed to restore state.
   Reload restores the dill snapshot, which is much cheaper than replaying
   arbitrary shell or network cells.
4. **No security claim.** Generated Python and `%%bash` run with the user's
   permissions. `dill` loads executable Python object graphs. Use only state
   files you trust; this is a productivity/control-plane feature, not a
   sandbox.
5. **No concurrent cells.** `executionMode: "sequential"` matches the single
   shared namespace. An interrupted cell that ignores SIGINT offers an
   interactive wait/restart choice instead of silently corrupting state.

## User interface

- Tool rows stay compact when collapsed. Expanded rows show syntax-highlighted
  cell source, a divider, and the captured output.
- `/kernel` — status and artifact paths.
- `/kernel export [path]` — write the accumulated cells to an `.ipynb`.
- `/kernel restart` — discard in-memory variables and start a fresh kernel.
- `PI_IPYTHON_EXPORT_IPYNB=0` — skip the automatic shutdown export.
- `PI_IPYTHON_KEEP_BUILTINS=1` — keep Pi's native tools.

## Install and test

The repository is the source of truth. Refresh Pi's replaceable global test
copy after making source changes:

```bash
./scripts/install-test-extension
```

Then start a fresh Pi session (or `/reload`) and use the `ipython` tool. A
minimal persistence check is:

```python
# first ipython call
numbers = [2, 3, 5]

# later ipython call
sum(numbers)
```

The second cell should return `10` without recreating `numbers`. The test suite
covers both the raw sidecar protocol and the TypeScript client, including
execution, restart, snapshot/restore, notebook export, and graceful
finalization. It makes no model-provider calls:

```bash
PI_IPYTHON_PYTHON="$HOME/.cache/pi-ipython/kernel-venv/bin/python" ./scripts/test
```

Without `PI_IPYTHON_PYTHON`, the tests use `python3`. That interpreter must
provide `ipykernel`, `jupyter_client`, `dill`, and `nest_asyncio`. The
TypeScript integration test uses Node's built-in type transformation and
therefore requires Node 22.7 or newer.

## Later work

- persist a lightweight namespace manifest with each tool result so the model
  can see useful variable names after compaction without serializing values;
- expose a compact cell count and namespace summary in the Pi TUI;
- allow a project-local Python bootstrap/skills directory;
- add explicit session/branch snapshot selection instead of one latest cwd
  snapshot; and
- optionally bridge Pi subagents and installed skills into the kernel. Those
  require host-owned lifecycle and policy APIs, so they should not be faked by
  arbitrary Python subprocess calls.
