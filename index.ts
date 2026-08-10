import {
  DynamicBorder,
  highlightCode,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { KernelBusyError, type KernelExecuteResult } from "./kernel-client.ts";
import { KernelRuntime } from "./kernel-runtime.ts";
import {
  applyEnvironmentOverrides,
  type IPythonConfig,
  readIPythonConfig,
  writeIPythonConfig,
} from "./config.ts";
import { openIPythonSettings } from "./settings.ts";

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

function appendOutput(current: string, next: string): string {
  if (!next) return current;
  if (!current || current.endsWith("\n") || next.startsWith("\n")) {
    return current + next;
  }
  return `${current}\n${next}`;
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
  let config = applyEnvironmentOverrides(readIPythonConfig());
  const runtime = new KernelRuntime(() => config);

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
    runtime.configurationChanged();
    syncToolSelection(pi, config);
    return config;
  }

  pi.on("session_start", (_event, ctx) => {
    config = applyEnvironmentOverrides(readIPythonConfig());
    runtime.beginSession(ctx);
    syncToolSelection(pi, config);
  });

  pi.on("session_shutdown", () => runtime.close());

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
      const working = (message?: string) => ctx.ui.setWorkingMessage(message);
      const report = (text: string) =>
        onUpdate?.({
          content: [{ type: "text", text }],
          details: { status: "starting" },
        });

      working("Starting IPython kernel...");
      try {
        const client = await runtime.getClient(ctx, (message) => {
          working(message);
          report(message);
        });

        const restoreNotice = await runtime.restorePreviousState();

        let kernelRestarted = false;
        let result: KernelExecuteResult;
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

        runtime.cellSettled();

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

  pi.on("before_agent_start", (event) => {
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
      const [verb = "status", ...rest] = args
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      try {
        if (verb === "status") {
          if (!runtime.isRunning) {
            ctx.ui.notify("IPython kernel not started yet.", "info");
            return;
          }
          ctx.ui.notify(
            `IPython kernel running.\n${runtime.statusLines().join("\n")}`,
            "info",
          );
          return;
        }
        if (verb !== "export" && verb !== "restart") {
          ctx.ui.notify(
            `Unknown /kernel verb: ${verb} (status|export|restart)`,
            "warning",
          );
          return;
        }

        const client = await runtime.getClient(ctx, (message) =>
          ctx.ui.notify(message, "info"),
        );
        if (verb === "export") {
          const target = rest.join(" ") || runtime.defaultNotebookPath;
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
          runtime.markRestarted();
          ctx.ui.notify(
            "IPython kernel restarted (in-memory state lost).",
            "info",
          );
          return;
        }
      } catch (error) {
        ctx.ui.notify(`IPython kernel error: ${String(error)}`, "error");
      }
    },
  });
}
