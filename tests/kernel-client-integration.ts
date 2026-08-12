#!/usr/bin/env -S node --experimental-transform-types --disable-warning=ExperimentalWarning

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { IPythonClient, resolveSidecarPath } from "../kernel-client.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const python = process.env.PI_IPYTHON_PYTHON ?? "python3";
const sidecar = join(root, "sidecar.py");
const cwd = mkdtempSync(join(tmpdir(), "pi-ipython-client-test-"));
const snapshot = join(cwd, "state.dill");
const notebook = join(cwd, "notebook.ipynb");
const finalSnapshot = join(cwd, "final-state.dill");
const finalNotebook = join(cwd, "final-notebook.ipynb");

if (resolveSidecarPath() !== sidecar) {
  throw new Error("sidecar.py was not resolved relative to kernel-client.ts");
}

const client = new IPythonClient(python, sidecar, cwd);
let finalized = false;

try {
  await client.start();

  const executed = await client.execute("answer = 6 * 7\nanswer");
  if (executed.result !== "42") {
    throw new Error(`unexpected execution result: ${JSON.stringify(executed)}`);
  }
  if (!Number.isInteger(executed.durationMs) || executed.durationMs < 0) {
    throw new Error(`invalid duration mapping: ${JSON.stringify(executed)}`);
  }

  const saved = await client.snapshot(snapshot);
  if (!saved.saved.includes("answer") || !existsSync(snapshot)) {
    throw new Error(`snapshot failed: ${JSON.stringify(saved)}`);
  }

  const exported = await client.exportIpynb(notebook);
  if (exported.cells !== 1 || !existsSync(notebook)) {
    throw new Error(`notebook export failed: ${JSON.stringify(exported)}`);
  }

  const abort = new AbortController();
  const interruptTimer = setTimeout(() => abort.abort(), 100);
  const interrupted = await client.execute("import time\ntime.sleep(30)", {
    signal: abort.signal,
  });
  clearTimeout(interruptTimer);
  if (interrupted.status !== "aborted") {
    throw new Error(`interrupt failed: ${JSON.stringify(interrupted)}`);
  }

  const blocker = client.execute("import time\ntime.sleep(0.3)");
  const queuedAbort = new AbortController();
  const queued = client.execute("queued_marker = True", {
    signal: queuedAbort.signal,
  });
  queuedAbort.abort();
  const [blockerResult, queuedResult] = await Promise.all([blocker, queued]);
  if (blockerResult.status !== "ok" || queuedResult.status !== "aborted") {
    throw new Error(
      `request-scoped cancellation failed: ${JSON.stringify({ blockerResult, queuedResult })}`,
    );
  }
  const marker = await client.execute("'queued_marker' in globals()");
  if (marker.result !== "False") {
    throw new Error(`cancelled cell still executed: ${JSON.stringify(marker)}`);
  }

  await client.restart();
  const restarted = await client.execute("'answer' in globals()");
  if (restarted.result !== "False") {
    throw new Error(
      `restart did not clear state: ${JSON.stringify(restarted)}`,
    );
  }

  const restored = await client.restore(snapshot);
  if (!restored.restored.includes("answer")) {
    throw new Error(`restore failed: ${JSON.stringify(restored)}`);
  }

  const restoredValue = await client.execute("answer");
  if (restoredValue.result !== "42") {
    throw new Error(
      `restored value is wrong: ${JSON.stringify(restoredValue)}`,
    );
  }

  await client.finalize(finalSnapshot, finalNotebook);
  finalized = true;
  if (!existsSync(finalSnapshot) || !existsSync(finalNotebook)) {
    throw new Error("finalize returned before writing its artifacts");
  }
} finally {
  if (!finalized) client.kill();
  rmSync(cwd, { recursive: true, force: true });
}

console.log("pi-ipython TypeScript client integration: PASS");
