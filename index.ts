import {
  DynamicBorder,
  highlightCode,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  KernelBusyError,
  PiIPythonClient,
  resolveKernelPython,
  resolveSidecarPath,
} from "./kernel-client.ts";
import {
  applyEnvironmentOverrides,
  type IPythonConfig,
  readIPythonConfig,
  writeIPythonConfig,
} from "./config.ts";
import { openIPythonSettings } from "./settings.ts";

const SNAPSHOT_DEBOUNCE_MS = 1500;
const FINALIZE_TIMEOUT_MS = 8000;

/** Pi's native file/shell tools; tools from other extensions stay untouched. */
const BUILTIN_TOOL_NAMES = new Set([
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
]);

const BUSY_PROMPT = [
  "Interrupted IPython cell is still running",
  "Ctrl+C / Esc sent an interrupt, but the previous cell has not stopped. A new ipython call cannot start until it finishes.",
  "Waiting preserves kernel state. Restarting the kernel loses in-memory variables, imports, and running tasks.",
].join("\n");
const BUSY_WAIT = "Wait and preserve state";
const BUSY_KILL = "Kill kernel and restart";
const BUSY_CANCEL = "Cancel";

const KERNEL_RESET_NOTICE = [
  "<ipython_kernel_reset>",
  "The IPython kernel was restarted after a previous interrupted cell kept running. Variables, imports, async tasks, and open resources from before the restart are gone; recreate them before using them.",
  "</ipython_kernel_reset>",
].join("\n");

const IPYTHON_DOCTRINE = `
## IPython kernel (ipython tool)

The ipython tool runs a persistent IPython kernel for this directory. Its state — variables, imports, loaded data, helper functions — survives across tool calls and, on a best-effort basis, across session resumes in the same directory. Use it for the code side of your work:

- Prefer ipython for iterative, stateful, or exploratory work: multi-step computations, data analysis, parsing, or anything where intermediate results should stay available instead of re-reading files.
- Use %%bash cells for shell commands. %%bash must be the first line of the cell — no comments, blank lines, or Python statements before it.
- Shell state does NOT persist between %%bash cells (each runs in a fresh subshell). Keep dependent shell steps in one cell, or use %cd <dir> and os.environ['VAR'] = '...' (%env VAR=...) which do persist.
- Python state DOES persist across cells: named variables, imports, functions, and parsed data remain available in every later turn.
- Assign read/search results to named variables so you can reuse them later without re-reading files.
- Do not install packages into the kernel just to make an external project import or run there. Run project code through its own environment (uv run ..., .venv/bin/python ..., the project's own CLI) and treat its output as the relevant result.
- The kernel writes real files to disk; everything it produces is on your filesystem, reviewable like any other change.
- It is fine to keep using read/edit/ffgrep/bash for quick single-file operations; prefer ipython when state or iteration matters.
`;

type KernelState = {
  client?: PiIPythonClient;
  clientStart?: Promise<PiIPythonClient>;
  cwd?: string;
  stateDir?: string;
  snapshotPath?: string;
  notebookPath?: string;
  restoreDone: boolean;
  snapshotTimer?: ReturnType<typeof setTimeout>;
  snapshotInFlight: boolean;
  snapshotDirty: boolean;
};

const state: KernelState = {
  restoreDone: false,
  snapshotInFlight: false,
  snapshotDirty: false,
};
let config = applyEnvironmentOverrides(readIPythonConfig());

function syncToolSelection(pi: ExtensionAPI, next: IPythonConfig): void {
  const available = new Set(pi.getAllTools().map(({ name }) => name));
  const active = new Set(pi.getActiveTools());

  if (next.enabled) active.add("ipython");
  else active.delete("ipython");

  for (const name of BUILTIN_TOOL_NAMES) {
    if (!available.has(name)) continue;
    if (next.enabled && next.disableBuiltins) active.delete(name);
    else active.add(name);
  }
  pi.setActiveTools([...active]);
}

function resetState(): void {
  if (state.snapshotTimer) clearTimeout(state.snapshotTimer);
  state.client = undefined;
  state.clientStart = undefined;
  state.cwd = undefined;
  state.stateDir = undefined;
  state.snapshotPath = undefined;
  state.notebookPath = undefined;
  state.restoreDone = false;
  state.snapshotInFlight = false;
  state.snapshotDirty = false;
}

async function ensureClient(
  ctx: ExtensionContext,
  onProgress: (message: string) => void,
): Promise<PiIPythonClient> {
  if (state.client?.isRunning) return state.client;
  if (state.clientStart) return state.clientStart;
  state.client?.kill();
  state.client = undefined;

  const starting = (async () => {
    const python = await resolveKernelPython(onProgress);
    const client = new PiIPythonClient(
      python,
      resolveSidecarPath(),
      state.cwd ?? ctx.cwd,
    );
    await client.start(onProgress);
    state.client = client;
    return client;
  })();
  state.clientStart = starting;
  try {
    return await starting;
  } finally {
    if (state.clientStart === starting) state.clientStart = undefined;
  }
}

/** Debounced dill snapshot after each settled user cell. */
function scheduleSnapshot(): void {
  if (!config.snapshotState) return;
  state.snapshotDirty = true;
  if (!state.client || !state.snapshotPath || state.snapshotInFlight) return;
  if (state.snapshotTimer) clearTimeout(state.snapshotTimer);
  state.snapshotTimer = setTimeout(flushSnapshot, SNAPSHOT_DEBOUNCE_MS);
}

function flushSnapshot(): void {
  state.snapshotTimer = undefined;
  const client = state.client;
  const path = state.snapshotPath;
  if (!client || !path || state.snapshotInFlight || !state.snapshotDirty)
    return;

  state.snapshotDirty = false;
  state.snapshotInFlight = true;
  void client
    .snapshot(path)
    .catch(() => {
      // Best effort; the next settled cell schedules another snapshot.
    })
    .finally(() => {
      state.snapshotInFlight = false;
      if (state.snapshotDirty && state.client === client) {
        state.snapshotTimer = setTimeout(flushSnapshot, 0);
      }
    });
}

function appendOutput(current: string, next: string): string {
  if (!next) return current;
  if (!current || current.endsWith("\n") || next.startsWith("\n")) {
    return current + next;
  }
  return `${current}\n${next}`;
}

/** Revive the previous session's namespace in this directory, once per session. */
async function maybeRestore(
  ctx: ExtensionContext,
): Promise<string | undefined> {
  if (!config.restoreState) {
    state.restoreDone = true;
    return undefined;
  }
  if (state.restoreDone || !state.client || !state.snapshotPath)
    return undefined;
  state.restoreDone = true;
  if (!existsSync(state.snapshotPath)) return undefined;
  try {
    const res = await state.client.restore(state.snapshotPath);
    const lines = ["<ipython_state_restored>"];
    if (res.restored.length > 0) {
      lines.push(
        `Restored ${res.restored.length} variable(s) from the previous session in this directory: ${res.restored.join(", ")}.`,
      );
    }
    if (res.failed.length > 0) {
      lines.push(
        `Failed to restore: ${res.failed.map((f) => `${f.name} (${f.reason})`).join("; ")}.`,
      );
    }
    if (res.restored.length === 0 && res.failed.length === 0) {
      lines.push("The previous session's kernel state was empty.");
    }
    lines.push("</ipython_state_restored>");
    return lines.join("\n");
  } catch {
    return undefined;
  }
}

function chooseBusyAction(
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  if (!ctx.hasUI) return Promise.resolve(undefined);
  return ctx.ui.select(BUSY_PROMPT, [BUSY_WAIT, BUSY_KILL, BUSY_CANCEL], {
    signal,
  });
}

export default function (pi: ExtensionAPI) {
  function saveAndApplyConfig(
    ctx: ExtensionContext,
    next: IPythonConfig,
  ): IPythonConfig | undefined {
    const saved = writeIPythonConfig(next);
    if (!saved.ok) {
      ctx.ui.notify(`Failed to save IPython settings: ${saved.error}`, "error");
      return undefined;
    }

    config = applyEnvironmentOverrides(next);
    if (!config.snapshotState) {
      if (state.snapshotTimer) clearTimeout(state.snapshotTimer);
      state.snapshotTimer = undefined;
      state.snapshotDirty = false;
    }
    syncToolSelection(pi, config);
    return config;
  }

  pi.on("session_start", async (_event, ctx) => {
    config = applyEnvironmentOverrides(readIPythonConfig());
    resetState();
    state.cwd = ctx.cwd;
    const sessionDir = ctx.sessionManager.getSessionDir();
    state.stateDir = join(sessionDir, "pi-ipython");
    mkdirSync(state.stateDir, { recursive: true });
    state.snapshotPath = join(state.stateDir, "kernel-state.dill");
    state.notebookPath = join(state.stateDir, "kernel-notebook.ipynb");

    syncToolSelection(pi, config);
  });

  pi.on("session_shutdown", async () => {
    if (state.snapshotTimer) {
      clearTimeout(state.snapshotTimer);
      state.snapshotTimer = undefined;
    }
    state.snapshotDirty = false;
    const client = state.client;
    state.client = undefined;
    if (!client) return;
    const work = client.finalize(
      config.snapshotState ? state.snapshotPath : undefined,
      config.exportNotebook ? state.notebookPath : undefined,
    );
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        work,
        new Promise<void>((resolve) => {
          timeout = setTimeout(() => {
            client.kill();
            resolve();
          }, FINALIZE_TIMEOUT_MS);
        }),
      ]);
    } catch {
      // Never let shutdown cleanup crash the session teardown.
      client.kill();
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  });

  pi.registerTool({
    name: "ipython",
    label: "ipython",
    description:
      "Execute Python code or %%bash shell cells in a persistent IPython kernel for the current project directory. Variables, imports, and loaded data persist across calls (and are revived on a best-effort basis when a session in the same directory is resumed). Prefer this tool for iterative or stateful code work: multi-step computations, data analysis, file processing, and shell orchestration via %%bash cells.",
    promptSnippet:
      "ipython - persistent IPython kernel for Python scratchpad code and %%bash orchestration",
    promptGuidelines: [
      "Use ipython for iterative, stateful, or exploratory code: multi-step computations, data analysis, and anything where intermediate state should persist across turns.",
      "Use ipython %%bash cells (first line of the cell) for shell commands; shell state does not persist between cells, Python state does.",
    ],
    parameters: Type.Object({
      code: Type.String({
        description:
          "Python code or a %%bash shell cell to execute in the persistent kernel.",
      }),
    }),
    renderCall(args, theme, context) {
      if (!context.executionStarted) return new Container();
      let text = `${theme.fg("dim", "•")} ${theme.bold(
        context.isPartial ? "Running IPython" : "Ran IPython",
      )}`;
      if (context.expanded && args.code.trim()) {
        const language = args.code.trimStart().startsWith("%%bash")
          ? "bash"
          : "python";
        text += `\n\n${highlightCode(args.code, language).join("\n")}`;
      }
      return new Text(text, 0, 0);
    },
    renderResult(result, options, theme) {
      const output = result.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n");
      const renderedOutput = new Text(
        theme.fg("toolOutput", output || "(no output)"),
        0,
        0,
      );
      if (!options.expanded) {
        return config.showOutputWhenCollapsed
          ? renderedOutput
          : new Container();
      }

      const expanded = new Container();
      expanded.addChild(new Spacer(1));
      expanded.addChild(
        new DynamicBorder((line: string) => theme.fg("borderMuted", line)),
      );
      expanded.addChild(new Spacer(1));
      expanded.addChild(renderedOutput);
      return expanded;
    },
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (!config.enabled) throw new Error("pi-ipython is disabled");
      const working = (message?: string) => {
        try {
          ctx.ui.setWorkingMessage(message);
        } catch {
          // cosmetic; stale UI context
        }
      };
      const report = (text: string) =>
        onUpdate?.({
          content: [{ type: "text", text }],
          details: { status: "starting" },
        });

      working("Starting IPython kernel...");
      try {
        const client = await ensureClient(ctx, (message) => {
          working(message);
          report(message);
        });

        const restoreNotice = await maybeRestore(ctx);

        let kernelRestarted = false;
        let result: Awaited<ReturnType<PiIPythonClient["execute"]>>;
        for (;;) {
          try {
            result = await client.execute(params.code, {
              signal,
              maxOutputChars: config.maxOutputChars,
              onStream: (text, name) => {
                onUpdate?.({
                  content: [{ type: "text", text }],
                  details: { status: name === "stderr" ? "error" : "ok" },
                });
              },
            });
            break;
          } catch (error) {
            if (!(error instanceof KernelBusyError) || signal?.aborted)
              throw error;
            const action = await chooseBusyAction(ctx, signal);
            if (action === BUSY_WAIT) {
              working("Waiting for IPython kernel...");
              report(
                "Waiting for the IPython kernel to finish the interrupted cell...",
              );
              continue;
            }
            if (action === BUSY_KILL) {
              working("Restarting IPython kernel...");
              report("Restarting the IPython kernel...");
              await client.restart();
              kernelRestarted = true;
              continue;
            }
            return {
              content: [
                {
                  type: "text",
                  text: "IPython execution cancelled because the kernel stayed busy.",
                },
              ],
              details: { status: "aborted", kernelRestarted },
            };
          }
        }

        scheduleSnapshot();

        let text = "";
        if (restoreNotice) text += `${restoreNotice}\n\n`;
        if (kernelRestarted) text += `${KERNEL_RESET_NOTICE}\n\n`;
        text = appendOutput(text, result.stdout);
        text = appendOutput(text, result.stderr);
        text = appendOutput(text, result.result);
        if (result.status === "error" && result.error) {
          text = appendOutput(text, result.error.traceback.join("\n"));
        }
        if (result.status === "aborted") {
          text = appendOutput(text, "Execution aborted (interrupted).");
        }

        return {
          content: [{ type: "text", text: text || "(no output)" }],
          details: {
            status: result.status,
            durationMs: result.durationMs,
            stdout: result.stdout,
            stderr: result.stderr,
            result: result.result,
            error: result.error,
            truncated: result.truncated,
            kernelRestarted,
            cells: result.cells,
          },
        };
      } finally {
        working(undefined);
      }
    },
  });

  pi.on("tool_result", (event) => {
    if (event.toolName !== "ipython") return;
    const status = (event.details as { status?: string } | undefined)?.status;
    if (status === "error" || status === "aborted") return { isError: true };
  });

  pi.on("before_agent_start", async (event) => {
    if (!config.enabled) return;
    return { systemPrompt: event.systemPrompt + IPYTHON_DOCTRINE };
  });

  pi.registerCommand("pithon", {
    description: "Configure the IPython extension",
    handler: async (_args, ctx) => {
      config = applyEnvironmentOverrides(readIPythonConfig());
      syncToolSelection(pi, config);
      await openIPythonSettings(ctx, config, (next) =>
        saveAndApplyConfig(ctx, next),
      );
    },
  });

  pi.registerCommand("kernel", {
    description: "IPython kernel: status, export notebook, restart",
    handler: async (args, ctx) => {
      const [verb = "status"] = (args ?? "").trim().split(/\s+/);
      try {
        if (verb === "status") {
          if (!state.client?.isRunning) {
            ctx.ui.notify("IPython kernel not started yet.", "info");
            return;
          }
          const lines = [
            `cwd: ${state.cwd ?? "?"}`,
            `state dir: ${state.stateDir ?? "?"}`,
            `snapshot: ${state.snapshotPath ?? "?"}${existsSync(state.snapshotPath ?? "") ? "" : " (none yet)"}`,
            `notebook: ${state.notebookPath ?? "?"}`,
          ];
          ctx.ui.notify(`IPython kernel running.\n${lines.join("\n")}`, "info");
          return;
        }
        const client = await ensureClient(ctx, (message) =>
          ctx.ui.notify(message, "info"),
        );
        if (verb === "export") {
          const target =
            args.split(/\s+/).slice(1).join(" ").trim() || state.notebookPath;
          if (!target) {
            ctx.ui.notify("No notebook path (session dir missing).", "error");
            return;
          }
          const res = await client.exportIpynb(target);
          ctx.ui.notify(`Exported ${res.cells} cell(s) to ${res.path}`, "info");
          return;
        }
        if (verb === "restart") {
          await client.restart();
          state.restoreDone = true;
          ctx.ui.notify(
            "IPython kernel restarted (in-memory state lost).",
            "info",
          );
          return;
        }
        ctx.ui.notify(
          `Unknown /kernel verb: ${verb} (status|export|restart)`,
          "warning",
        );
      } catch (error) {
        ctx.ui.notify(`IPython kernel error: ${String(error)}`, "error");
      }
    },
  });
}
