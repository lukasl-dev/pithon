import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_OUTPUT_LIMIT = 64 * 1024;
const BOOTSTRAP_MARKER = ".bootstrap-v1";
const KERNEL_PACKAGES = ["ipykernel", "jupyter_client", "dill", "nest-asyncio"];
const KERNEL_MODULES = ["ipykernel", "jupyter_client", "dill", "nest_asyncio"];

type StreamName = "stdout" | "stderr";

type RpcEvent = { event: string; name?: StreamName; text?: string };

type RpcOptions = {
  timeoutMs?: number;
  onEvent?: (event: RpcEvent) => void;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  onEvent?: RpcOptions["onEvent"];
};
type SidecarMessage = {
  id?: number;
  ok?: boolean;
  result?: unknown;
  error?: { code?: string; message?: string };
  event?: string;
  name?: StreamName;
  text?: string;
};
type WireExecuteResult = Omit<KernelExecuteResult, "durationMs"> & {
  duration_ms: number;
};

export interface KernelExecuteOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputChars?: number;
  record?: boolean;
  onStream?: (text: string, name: StreamName) => void;
}

export interface KernelExecuteResult {
  status: "ok" | "error" | "aborted";
  stdout: string;
  stderr: string;
  result: string;
  error?: { ename: string; evalue: string; traceback: string[] };
  truncated?: { stdout?: boolean; stderr?: boolean; result?: boolean };
  durationMs: number;
  cells: number;
}

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

function moduleDirectory(): string | undefined {
  try {
    const url = (import.meta as { url?: string }).url;
    if (url?.startsWith("file:")) return dirname(fileURLToPath(url));
  } catch {
    // jiti may compile this module as CommonJS.
  }
  return undefined;
}

export function resolveSidecarPath(): string {
  if (process.env.PI_IPYTHON_SIDECAR) {
    return process.env.PI_IPYTHON_SIDECAR;
  }

  const directories = [
    moduleDirectory(),
    join(homedir(), ".pi", "agent", "extensions", "pi-ipython"),
    join(process.cwd(), ".pi", "extensions", "pi-ipython"),
  ];
  for (const directory of directories) {
    if (!directory) continue;
    const path = join(directory, "sidecar.py");
    if (existsSync(path)) return path;
  }

  throw new Error(
    "pi-ipython: cannot find sidecar.py. Set PI_IPYTHON_SIDECAR or install the extension as ~/.pi/agent/extensions/pi-ipython/.",
  );
}

async function pythonHasKernel(python: string): Promise<boolean> {
  const imports = KERNEL_MODULES.map((module) => `import ${module}`).join("; ");
  try {
    await execFileAsync(python, ["-c", imports], { timeout: 15_000 });
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
    const userInstall = join(homedir(), ".local", "bin", "uv");
    return existsSync(userInstall) ? userInstall : undefined;
  }
}

export async function resolveKernelPython(
  onProgress?: (message: string) => void,
): Promise<string> {
  if (process.env.PI_IPYTHON_PYTHON) {
    return process.env.PI_IPYTHON_PYTHON;
  }

  const bundledPath = join(dirname(resolveSidecarPath()), "kernel-python.txt");
  if (existsSync(bundledPath)) {
    const bundledPython = readFileSync(bundledPath, "utf8").trim();
    if (bundledPython) return bundledPython;
  }

  const cacheDirectory = process.env.XDG_CACHE_HOME
    ? join(process.env.XDG_CACHE_HOME, "pi-ipython")
    : join(homedir(), ".cache", "pi-ipython");
  const environment = join(cacheDirectory, "kernel-venv");
  const python = join(environment, "bin", "python");
  const marker = join(cacheDirectory, BOOTSTRAP_MARKER);
  if (existsSync(python) && existsSync(marker)) return python;

  onProgress?.("Setting up the IPython kernel environment...");
  const uv = await findUv();
  if (uv) {
    try {
      await execFileAsync(uv, ["venv", environment], { timeout: 180_000 });
      await execFileAsync(
        uv,
        ["pip", "install", "--python", python, ...KERNEL_PACKAGES],
        { timeout: 600_000 },
      );
      writeFileSync(marker, `${new Date().toISOString()}\n`);
      return python;
    } catch (error) {
      onProgress?.(
        `uv setup failed (${String(error).slice(0, 200)}); trying system Python.`,
      );
    }
  }

  if (await pythonHasKernel("python3")) return "python3";
  throw new Error(
    "pi-ipython: no usable Python found. Set PI_IPYTHON_PYTHON to a Python with ipykernel, jupyter_client, dill, and nest-asyncio installed.",
  );
}

export class IPythonClient {
  private process?: ChildProcess;
  private stdout?: Interface;
  private stderr?: Interface;
  private readonly pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;
  private started = false;

  constructor(
    private readonly python: string,
    private readonly sidecarPath: string,
    private readonly cwd: string,
  ) {}

  get isRunning(): boolean {
    return this.started && this.process !== undefined;
  }

  async start(onProgress?: (message: string) => void): Promise<void> {
    if (this.started) return;

    onProgress?.("Starting IPython kernel...");
    const child = spawn(this.python, ["-u", this.sidecarPath], {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      detached: process.platform !== "win32",
    });
    this.process = child;
    this.watch(child);

    try {
      await this.request("ping", {}, { timeoutMs: 60_000 });
      await this.request("start", { cwd: this.cwd }, { timeoutMs: 120_000 });
      this.started = true;
    } catch (error) {
      this.kill();
      throw error;
    }
  }

  async interrupt(requestId?: number): Promise<void> {
    const params = requestId === undefined ? {} : { request_id: requestId };
    await this.request("interrupt", params, { timeoutMs: 5_000 });
  }

  async execute(
    code: string,
    options: KernelExecuteOptions = {},
  ): Promise<KernelExecuteResult> {
    const call = this.call<WireExecuteResult>(
      "execute",
      {
        code,
        timeout_ms: options.timeoutMs ?? 0,
        max_output_chars: options.maxOutputChars ?? DEFAULT_OUTPUT_LIMIT,
        record: options.record ?? true,
      },
      {
        onEvent: (event) => {
          if (event.event === "stream" && event.text !== undefined) {
            options.onStream?.(event.text, event.name ?? "stdout");
          }
        },
      },
    );

    const interrupt = () => {
      if (this.pending.has(call.id)) {
        void this.interrupt(call.id).catch(() => {});
      }
    };
    if (options.signal?.aborted) interrupt();
    else options.signal?.addEventListener("abort", interrupt, { once: true });

    try {
      const { duration_ms, ...result } = await call.promise;
      return { ...result, durationMs: duration_ms };
    } finally {
      options.signal?.removeEventListener("abort", interrupt);
    }
  }

  snapshot(path: string): Promise<{
    saved: string[];
    skipped: { name: string; reason: string }[];
    bytes: number;
  }> {
    return this.request("snapshot", { path }, { timeoutMs: 120_000 });
  }

  restore(path: string): Promise<{
    restored: string[];
    failed: { name: string; reason: string }[];
  }> {
    return this.request("restore", { path }, { timeoutMs: 120_000 });
  }

  exportIpynb(path: string): Promise<{ path: string; cells: number }> {
    return this.request("export_ipynb", { path }, { timeoutMs: 60_000 });
  }

  async restart(): Promise<void> {
    await this.request("restart", {}, { timeoutMs: 120_000 });
  }

  async finalize(snapshotPath?: string, notebookPath?: string): Promise<void> {
    if (snapshotPath) {
      await this.bestEffort("snapshot", () => this.snapshot(snapshotPath));
    }
    if (notebookPath) {
      await this.bestEffort("export", () => this.exportIpynb(notebookPath));
    }
    await this.bestEffort("shutdown", () =>
      this.request("shutdown", {}, { timeoutMs: 10_000 }),
    );
    this.kill();
  }

  kill(): void {
    this.started = false;
    this.failPending(new SidecarDiedError("sidecar killed"));

    const child = this.process;
    this.process = undefined;
    this.closeReaders();
    if (!child) return;

    try {
      if (child.pid && process.platform !== "win32") {
        process.kill(-child.pid, "SIGKILL");
      } else {
        child.kill("SIGKILL");
      }
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // It already exited.
      }
    }
  }

  private watch(child: ChildProcess): void {
    this.stderr = createInterface({ input: child.stderr! });
    this.stderr.on("line", (line) => console.error(`[pi-ipython] ${line}`));

    this.stdout = createInterface({ input: child.stdout! });
    this.stdout.on("line", (line) => this.receive(line));

    child.on("error", (error) => {
      if (this.process !== child) return;
      this.failPending(
        new SidecarDiedError(`sidecar spawn failed: ${error.message}`),
      );
    });
    child.on("exit", (code, signal) => {
      if (this.process !== child) return;
      this.process = undefined;
      this.started = false;
      this.closeReaders();
      this.failPending(
        new SidecarDiedError(`sidecar exited (code=${code}, signal=${signal})`),
      );
    });
  }

  private receive(line: string): void {
    if (!line.trim()) return;

    let message: SidecarMessage;
    try {
      message = JSON.parse(line) as SidecarMessage;
    } catch {
      this.failPending(new SidecarDiedError("invalid JSON from sidecar"));
      this.kill();
      return;
    }

    const pending =
      message.id === undefined ? undefined : this.pending.get(message.id);
    if (message.event) {
      pending?.onEvent?.({
        event: message.event,
        name: message.name,
        text: message.text,
      });
      return;
    }
    if (!pending || message.id === undefined) return;

    this.pending.delete(message.id);
    if (message.ok) {
      pending.resolve(message.result);
      return;
    }
    pending.reject(this.responseError(message));
  }

  private responseError(message: SidecarMessage): Error {
    const text = message.error?.message ?? "sidecar error";
    if (message.error?.code === "kernel_busy") return new KernelBusyError(text);
    if (message.error?.code === "timeout") {
      return new Error(`IPython execution timed out: ${text}`);
    }
    return new Error(`pi-ipython: ${text}`);
  }

  private call<T>(
    method: string,
    params: Record<string, unknown>,
    options: RpcOptions = {},
  ): { id: number; promise: Promise<T> } {
    const id = this.nextRequestId++;
    const promise = new Promise<T>((resolve, reject) => {
      const timer = options.timeoutMs
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`${method} timed out`));
          }, options.timeoutMs)
        : undefined;

      this.pending.set(id, {
        resolve: (value) => {
          if (timer) clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          if (timer) clearTimeout(timer);
          reject(error);
        },
        onEvent: options.onEvent,
      });
    });

    // A caller may intentionally abandon a request while kill() rejects it.
    void promise.catch(() => {});
    this.write(id, method, params);
    return { id, promise };
  }

  private request<T = unknown>(
    method: string,
    params: Record<string, unknown>,
    options?: RpcOptions,
  ): Promise<T> {
    return this.call<T>(method, params, options).promise;
  }

  private write(
    id: number,
    method: string,
    params: Record<string, unknown>,
  ): void {
    const stdin = this.process?.stdin;
    if (!stdin?.writable) {
      this.reject(id, new SidecarDiedError("sidecar is not running"));
      return;
    }

    stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
      if (error) {
        this.reject(
          id,
          new SidecarDiedError(`failed to write to sidecar: ${error.message}`),
        );
      }
    });
  }

  private reject(id: number, error: Error): void {
    const pending = this.pending.get(id);
    this.pending.delete(id);
    pending?.reject(error);
  }

  private failPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  private closeReaders(): void {
    this.stdout?.close();
    this.stderr?.close();
    this.stdout = undefined;
    this.stderr = undefined;
  }

  private async bestEffort(
    operation: string,
    run: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await run();
    } catch (error) {
      console.error(
        `[pi-ipython] finalize ${operation} failed: ${String(error)}`,
      );
    }
  }
}
