import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { IPythonConfig } from "./config.ts";
import {
  IPythonClient,
  resolveKernelPython,
  resolveSidecarPath,
} from "./kernel-client.ts";

const SNAPSHOT_DELAY_MS = 1_500;
const SHUTDOWN_GRACE_MS = 8_000;

type ProgressReporter = (message: string) => void;

export class KernelRuntime {
  private current?: IPythonClient;
  private starting?: Promise<IPythonClient>;
  private cwd?: string;
  private stateDirectory?: string;
  private snapshotPath?: string;
  private notebookPath?: string;
  private restored = false;
  private snapshotTimer?: ReturnType<typeof setTimeout>;
  private snapshotRunning = false;
  private snapshotPending = false;

  constructor(private readonly getConfig: () => IPythonConfig) {}

  beginSession(ctx: ExtensionContext): void {
    this.reset();
    this.cwd = ctx.cwd;
    this.stateDirectory = join(
      ctx.sessionManager.getSessionDir(),
      "pi-ipython",
    );
    mkdirSync(this.stateDirectory, { recursive: true });
    this.snapshotPath = join(this.stateDirectory, "kernel-state.dill");
    this.notebookPath = join(this.stateDirectory, "kernel-notebook.ipynb");
  }

  get isRunning(): boolean {
    return this.current?.isRunning ?? false;
  }

  get defaultNotebookPath(): string | undefined {
    return this.notebookPath;
  }

  statusLines(): string[] {
    return [
      `cwd: ${this.cwd ?? "?"}`,
      `state dir: ${this.stateDirectory ?? "?"}`,
      `snapshot: ${this.snapshotPath ?? "?"}${this.hasSnapshot() ? "" : " (none yet)"}`,
      `notebook: ${this.notebookPath ?? "?"}`,
    ];
  }

  async getClient(
    ctx: ExtensionContext,
    onProgress: ProgressReporter,
  ): Promise<IPythonClient> {
    if (this.current?.isRunning) return this.current;
    if (this.starting) return this.starting;

    this.current?.kill();
    this.current = undefined;

    const starting = this.startClient(ctx, onProgress);
    this.starting = starting;
    try {
      return await starting;
    } finally {
      if (this.starting === starting) this.starting = undefined;
    }
  }

  async restorePreviousState(): Promise<string | undefined> {
    const config = this.getConfig();
    if (!config.restoreState) {
      this.restored = true;
      return undefined;
    }
    if (this.restored || !this.current || !this.snapshotPath) return undefined;

    this.restored = true;
    if (!existsSync(this.snapshotPath)) return undefined;

    try {
      const { restored, failed } = await this.current.restore(
        this.snapshotPath,
      );
      const lines = ["<ipython_state_restored>"];
      if (restored.length) {
        lines.push(
          `Restored ${restored.length} variable(s) from the previous session in this directory: ${restored.join(", ")}.`,
        );
      }
      if (failed.length) {
        const failures = failed
          .map(({ name, reason }) => `${name} (${reason})`)
          .join("; ");
        lines.push(`Failed to restore: ${failures}.`);
      }
      if (!restored.length && !failed.length) {
        lines.push("The previous session's kernel state was empty.");
      }
      lines.push("</ipython_state_restored>");
      return lines.join("\n");
    } catch {
      return undefined;
    }
  }

  cellSettled(): void {
    if (!this.getConfig().snapshotState) return;

    this.snapshotPending = true;
    if (!this.current || !this.snapshotPath || this.snapshotRunning) return;

    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    this.snapshotTimer = setTimeout(this.flushSnapshot, SNAPSHOT_DELAY_MS);
  }

  configurationChanged(): void {
    if (this.getConfig().snapshotState) return;
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    this.snapshotTimer = undefined;
    this.snapshotPending = false;
  }

  markRestarted(): void {
    this.restored = true;
  }

  async close(): Promise<void> {
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    this.snapshotTimer = undefined;
    this.snapshotPending = false;

    const client = this.current;
    this.current = undefined;
    if (!client) return;

    const config = this.getConfig();
    const finalize = client.finalize(
      config.snapshotState ? this.snapshotPath : undefined,
      config.exportNotebook ? this.notebookPath : undefined,
    );

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        finalize,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            client.kill();
            resolve();
          }, SHUTDOWN_GRACE_MS);
        }),
      ]);
    } catch {
      client.kill();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async startClient(
    ctx: ExtensionContext,
    onProgress: ProgressReporter,
  ): Promise<IPythonClient> {
    const python = await resolveKernelPython(onProgress);
    const client = new IPythonClient(
      python,
      resolveSidecarPath(),
      this.cwd ?? ctx.cwd,
    );
    await client.start(onProgress);
    this.current = client;
    return client;
  }

  private hasSnapshot(): boolean {
    return this.snapshotPath ? existsSync(this.snapshotPath) : false;
  }

  private flushSnapshot = (): void => {
    this.snapshotTimer = undefined;
    const client = this.current;
    const path = this.snapshotPath;
    if (!client || !path || this.snapshotRunning || !this.snapshotPending)
      return;

    this.snapshotPending = false;
    this.snapshotRunning = true;
    void client
      .snapshot(path)
      .catch(() => {})
      .finally(() => {
        this.snapshotRunning = false;
        if (this.snapshotPending && this.current === client) {
          this.snapshotTimer = setTimeout(this.flushSnapshot, 0);
        }
      });
  };

  private reset(): void {
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    this.current?.kill();
    this.current = undefined;
    this.starting = undefined;
    this.cwd = undefined;
    this.stateDirectory = undefined;
    this.snapshotPath = undefined;
    this.notebookPath = undefined;
    this.restored = false;
    this.snapshotTimer = undefined;
    this.snapshotRunning = false;
    this.snapshotPending = false;
  }
}
