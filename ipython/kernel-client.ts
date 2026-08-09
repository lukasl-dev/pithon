// pi-ipython kernel client: spawns the Python sidecar and speaks its JSON-lines
// protocol. Owns process lifetime, request/response correlation, and the abort
// -> interrupt mapping (aborting an execute interrupts the running cell instead
// of tearing the kernel down, so state is preserved).

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_MAX_OUTPUT_CHARS = 65536;
const BOOTSTRAP_MARKER = ".bootstrap-v1";
const KERNEL_PACKAGES = ["ipykernel", "jupyter_client", "dill", "nest-asyncio"];
const KERNEL_MODULES = ["ipykernel", "jupyter_client", "dill", "nest_asyncio"];

export interface KernelExecuteResult {
  status: "ok" | "error" | "aborted";
  stdout: string;
  stderr: string;
  result?: string;
  error?: { ename: string; evalue: string; traceback: string[] };
  truncated?: { stdout?: boolean; stderr?: boolean; result?: boolean };
  durationMs: number;
  cells: number;
}

type WireKernelExecuteResult = Omit<KernelExecuteResult, "durationMs"> & {
  duration_ms: number;
};

export class KernelBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KernelBusyError";
  }
}

export class SidecarDiedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SidecarDiedError";
  }
}

type PendingRpc = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  onEvent?: (event: { event: string; name?: string; text?: string }) => void;
};

/** Absolute path of the extension directory containing this module. */
function moduleDir(): string | undefined {
  try {
    // jiti may compile to CJS where import.meta is unavailable; fall back to
    // known install locations below.
    const url = (import.meta as { url?: string }).url;
    if (url && url.startsWith("file:")) return dirname(fileURLToPath(url));
  } catch {
    // ignore
  }
  return undefined;
}

/** Locate sidecar.py: env override, next to this module, then known install dirs. */
export function resolveSidecarPath(): string {
  const fromEnv = process.env.PI_IPYTHON_SIDECAR;
  if (fromEnv) return fromEnv;
  const candidates = [
    moduleDir(),
    join(homedir(), ".pi", "agent", "extensions", "pi-ipython"),
    join(process.cwd(), ".pi", "extensions", "pi-ipython"),
  ];
  for (const dir of candidates) {
    if (!dir) continue;
    const candidate = join(dir, "sidecar.py");
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    "pi-ipython: cannot find sidecar.py. Set PI_IPYTHON_SIDECAR or install the extension as ~/.pi/agent/extensions/pi-ipython/.",
  );
}

async function hasKernelDependencies(python: string): Promise<boolean> {
  try {
    await execFileAsync(
      python,
      ["-c", KERNEL_MODULES.map((module) => `import ${module}`).join("; ")],
      { timeout: 15_000 },
    );
    return true;
  } catch {
    return false;
  }
}

async function findUv(): Promise<string | undefined> {
  try {
    await execFileAsync("uv", ["--version"], { timeout: 10_000 });
    return "uv";
  } catch {
    const local = join(homedir(), ".local", "bin", "uv");
    if (existsSync(local)) return local;
    return undefined;
  }
}

/**
 * Resolve the Python that should host the kernel: PI_IPYTHON_PYTHON, a baked
 * path next to the sidecar (Nix build), a uv-bootstrapped venv in the user
 * cache, or the system python3 as a last resort.
 */
export async function resolveKernelPython(
  onProgress?: (message: string) => void,
): Promise<string> {
  const fromEnv = process.env.PI_IPYTHON_PYTHON;
  if (fromEnv) return fromEnv;

  const sidecarDir = dirname(resolveSidecarPath());
  const baked = join(sidecarDir, "kernel-python.txt");
  if (existsSync(baked)) {
    const value = readFileSync(baked, "utf8").trim();
    if (value) return value;
  }

  const cacheRoot = process.env.XDG_CACHE_HOME
    ? join(process.env.XDG_CACHE_HOME, "pi-ipython")
    : join(homedir(), ".cache", "pi-ipython");
  const venv = join(cacheRoot, "kernel-venv");
  const python = join(venv, "bin", "python");
  const marker = join(cacheRoot, BOOTSTRAP_MARKER);
  if (existsSync(python) && existsSync(marker)) return python;

  onProgress?.(
    "Setting up the IPython kernel environment (one-time uv bootstrap)...",
  );
  const uv = await findUv();
  if (uv) {
    try {
      await execFileAsync(uv, ["venv", venv], { timeout: 180_000 });
      await execFileAsync(
        uv,
        ["pip", "install", "--python", python, ...KERNEL_PACKAGES],
        {
          timeout: 600_000,
        },
      );
      writeFileSync(marker, new Date().toISOString() + "\n");
      return python;
    } catch (error) {
      onProgress?.(
        `uv bootstrap failed (${String(error).slice(0, 200)}); falling back to system python.`,
      );
    }
  }

  if (await hasKernelDependencies("python3")) return "python3";
  throw new Error(
    "pi-ipython: no Python with ipykernel found. Set PI_IPYTHON_PYTHON to a python that has ipykernel, jupyter_client, dill, and nest-asyncio installed.",
  );
}

export class PiIPythonClient {
  private proc?: ChildProcess;
  private pending = new Map<number, PendingRpc>();
  private nextId = 1;
  private started = false;
  private sidecarStderr?: Interface;

  constructor(
    private readonly python: string,
    private readonly sidecarPath: string,
    private readonly cwd: string,
  ) {}

  get isRunning(): boolean {
    return this.started && this.proc !== undefined;
  }

  async start(onProgress?: (message: string) => void): Promise<void> {
    if (this.started) return;
    onProgress?.("Starting IPython kernel...");
    const proc = spawn(this.python, ["-u", this.sidecarPath], {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      detached: process.platform !== "win32",
    });
    this.proc = proc;
    this.sidecarStderr = createInterface({ input: proc.stderr! });
    this.sidecarStderr.on("line", (line) => {
      console.error(`[pi-ipython] ${line}`);
    });

    const lines = createInterface({ input: proc.stdout! });
    lines.on("line", (line) => {
      if (!line.trim()) return;
      let msg: {
        id?: number;
        ok?: boolean;
        result?: unknown;
        error?: { code?: string; message?: string };
        event?: string;
        name?: string;
        text?: string;
      };
      try {
        msg = JSON.parse(line);
      } catch {
        this.failAll(new SidecarDiedError("invalid JSON from sidecar"));
        this.kill();
        return;
      }
      const pending =
        msg.id !== undefined ? this.pending.get(msg.id) : undefined;
      if (msg.event && pending?.onEvent) {
        pending.onEvent(msg as { event: string; name?: string; text?: string });
        return;
      }
      if (!pending) return;
      this.pending.delete(msg.id!);
      if (msg.ok) {
        pending.resolve(msg.result);
      } else {
        const code = msg.error?.code;
        const message = msg.error?.message ?? "sidecar error";
        const err =
          code === "kernel_busy"
            ? new KernelBusyError(message)
            : code === "timeout"
              ? new Error(`IPython execution timed out: ${message}`)
              : new Error(`pi-ipython: ${message}`);
        pending.reject(err);
      }
    });

    proc.on("error", (error) => {
      if (this.proc !== proc) return;
      this.failAll(
        new SidecarDiedError(`sidecar spawn failed: ${error.message}`),
      );
    });
    proc.on("exit", (code, signal) => {
      if (this.proc !== proc) return;
      this.proc = undefined;
      this.started = false;
      this.sidecarStderr?.close();
      this.sidecarStderr = undefined;
      this.failAll(
        new SidecarDiedError(`sidecar exited (code=${code}, signal=${signal})`),
      );
    });

    try {
      await this.request("ping", {}, { timeoutMs: 60_000 });
      // The sidecar only spawns its kernel on an explicit "start".
      await this.request("start", { cwd: this.cwd }, { timeoutMs: 120_000 });
      this.started = true;
    } catch (error) {
      this.kill();
      throw error;
    }
  }

  private rpc(
    method: string,
    params: Record<string, unknown>,
    opts?: { timeoutMs?: number; onEvent?: PendingRpc["onEvent"] },
  ): { id: number; promise: Promise<unknown> } {
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = opts?.timeoutMs
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`${method} timed out`));
          }, opts.timeoutMs)
        : undefined;
      this.pending.set(id, {
        resolve: (value) => {
          if (timer) clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          if (timer) clearTimeout(timer);
          reject(error);
        },
        onEvent: opts?.onEvent,
      });
    });
    // Mark the promise handled so an abandoned rpc (e.g. failAll on kill while
    // the caller already detached) can never crash the process as an unhandled
    // rejection. The real await still receives the rejection.
    promise.catch(() => {});
    const stdin = this.proc?.stdin;
    if (!stdin?.writable) {
      const pending = this.pending.get(id);
      this.pending.delete(id);
      pending?.reject(new SidecarDiedError("sidecar is not running"));
    } else {
      stdin.write(JSON.stringify({ id, method, params }) + "\n", (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        this.pending.delete(id);
        pending?.reject(
          new SidecarDiedError(`failed to write to sidecar: ${error.message}`),
        );
      });
    }
    return { id, promise };
  }

  private request<T = unknown>(
    method: string,
    params: Record<string, unknown>,
    opts?: { timeoutMs?: number; onEvent?: PendingRpc["onEvent"] },
  ): Promise<T> {
    return this.rpc(method, params, opts).promise as Promise<T>;
  }

  async interrupt(requestId?: number): Promise<void> {
    await this.request(
      "interrupt",
      requestId === undefined ? {} : { request_id: requestId },
      { timeoutMs: 5_000 },
    );
  }

  async execute(
    code: string,
    opts?: {
      signal?: AbortSignal;
      timeoutMs?: number;
      maxOutputChars?: number;
      record?: boolean;
      onStream?: (text: string, name: "stdout" | "stderr") => void;
    },
  ): Promise<KernelExecuteResult> {
    const { id, promise } = this.rpc(
      "execute",
      {
        code,
        timeout_ms: opts?.timeoutMs ?? 0,
        max_output_chars: opts?.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS,
        record: opts?.record ?? true,
      },
      {
        onEvent: (event) => {
          if (event.event === "stream" && typeof event.text === "string") {
            opts?.onStream?.(
              event.text,
              event.name === "stderr" ? "stderr" : "stdout",
            );
          }
        },
      },
    );
    const onAbort = () => {
      if (this.pending.has(id)) {
        void this.interrupt(id).catch(() => {});
      }
    };
    if (opts?.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      const result = (await promise) as WireKernelExecuteResult;
      const { duration_ms, ...rest } = result;
      return { ...rest, durationMs: duration_ms };
    } finally {
      opts?.signal?.removeEventListener("abort", onAbort);
    }
  }

  async snapshot(path: string): Promise<{
    saved: string[];
    skipped: { name: string; reason: string }[];
    bytes: number;
  }> {
    return this.request("snapshot", { path }, { timeoutMs: 120_000 });
  }

  async restore(path: string): Promise<{
    restored: string[];
    failed: { name: string; reason: string }[];
  }> {
    return this.request("restore", { path }, { timeoutMs: 120_000 });
  }

  async exportIpynb(path: string): Promise<{ path: string; cells: number }> {
    return this.request("export_ipynb", { path }, { timeoutMs: 60_000 });
  }

  async restart(): Promise<void> {
    await this.request("restart", {}, { timeoutMs: 120_000 });
  }

  /** Final best-effort snapshot/export/shutdown; never throws. */
  async finalize(snapshotPath?: string, notebookPath?: string): Promise<void> {
    try {
      if (snapshotPath) await this.snapshot(snapshotPath);
    } catch (error) {
      console.error(`[pi-ipython] finalize snapshot failed: ${String(error)}`);
    }
    try {
      if (notebookPath) await this.exportIpynb(notebookPath);
    } catch (error) {
      console.error(`[pi-ipython] finalize export failed: ${String(error)}`);
    }
    try {
      await this.request("shutdown", {}, { timeoutMs: 10_000 });
    } catch (error) {
      console.error(`[pi-ipython] finalize shutdown failed: ${String(error)}`);
    }
    this.kill();
  }

  /** Hard-kill the sidecar process (and with it the kernel). */
  kill(): void {
    this.started = false;
    this.failAll(new SidecarDiedError("sidecar killed"));
    const proc = this.proc;
    this.proc = undefined;
    this.sidecarStderr?.close();
    this.sidecarStderr = undefined;
    try {
      if (proc?.pid && process.platform !== "win32") {
        process.kill(-proc.pid, "SIGKILL");
      } else {
        proc?.kill("SIGKILL");
      }
    } catch {
      try {
        proc?.kill("SIGKILL");
      } catch {
        // Process already exited.
      }
    }
  }

  private failAll(error: Error): void {
    for (const [id, pending] of [...this.pending]) {
      this.pending.delete(id);
      pending.reject(error);
    }
  }
}
