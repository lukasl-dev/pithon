import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface IPythonConfig {
  enabled: boolean;
  disableBuiltins: boolean;
  restoreState: boolean;
  snapshotState: boolean;
  exportNotebook: boolean;
  showOutputWhenCollapsed: boolean;
  maxOutputChars: number;
}

export const DEFAULT_IPYTHON_CONFIG: IPythonConfig = {
  enabled: true,
  disableBuiltins: true,
  restoreState: true,
  snapshotState: true,
  exportNotebook: true,
  showOutputWhenCollapsed: true,
  maxOutputChars: 64 * 1024,
};

const OUTPUT_LIMITS = new Set([16 * 1024, 64 * 1024, 256 * 1024]);
const CONFIG_BASENAME = "pi-ipython.json";

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function normalizeIPythonConfig(value: unknown): IPythonConfig {
  const input =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const maxOutputChars =
    typeof input.maxOutputChars === "number" &&
    OUTPUT_LIMITS.has(input.maxOutputChars)
      ? input.maxOutputChars
      : DEFAULT_IPYTHON_CONFIG.maxOutputChars;

  return {
    enabled: booleanValue(input.enabled, DEFAULT_IPYTHON_CONFIG.enabled),
    disableBuiltins: booleanValue(
      input.disableBuiltins,
      DEFAULT_IPYTHON_CONFIG.disableBuiltins,
    ),
    restoreState: booleanValue(
      input.restoreState,
      DEFAULT_IPYTHON_CONFIG.restoreState,
    ),
    snapshotState: booleanValue(
      input.snapshotState,
      DEFAULT_IPYTHON_CONFIG.snapshotState,
    ),
    exportNotebook: booleanValue(
      input.exportNotebook,
      DEFAULT_IPYTHON_CONFIG.exportNotebook,
    ),
    showOutputWhenCollapsed: booleanValue(
      input.showOutputWhenCollapsed,
      DEFAULT_IPYTHON_CONFIG.showOutputWhenCollapsed,
    ),
    maxOutputChars,
  };
}

export function getIPythonConfigPath(agentDir = getAgentDir()): string {
  return join(agentDir, CONFIG_BASENAME);
}

export function readIPythonConfig(
  configPath = getIPythonConfigPath(),
): IPythonConfig {
  if (!existsSync(configPath)) return { ...DEFAULT_IPYTHON_CONFIG };
  try {
    return normalizeIPythonConfig(
      JSON.parse(readFileSync(configPath, "utf8")) as unknown,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[pi-ipython] Failed to read ${configPath}: ${message}`);
    return { ...DEFAULT_IPYTHON_CONFIG };
  }
}

/** Existing environment variables remain deployment-level overrides. */
export function applyEnvironmentOverrides(
  config: IPythonConfig,
): IPythonConfig {
  return {
    ...config,
    disableBuiltins:
      process.env.PI_IPYTHON_KEEP_BUILTINS === "1"
        ? false
        : config.disableBuiltins,
    exportNotebook:
      process.env.PI_IPYTHON_EXPORT_IPYNB === "0"
        ? false
        : config.exportNotebook,
  };
}

export function writeIPythonConfig(
  config: IPythonConfig,
  configPath = getIPythonConfigPath(),
): { ok: true } | { ok: false; error: string } {
  const temporaryPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    mkdirSync(dirname(configPath), { recursive: true });
    const normalized = normalizeIPythonConfig(config);
    writeFileSync(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporaryPath, configPath);
    return { ok: true };
  } catch (error) {
    try {
      rmSync(temporaryPath, { force: true });
    } catch {
      // Preserve the original write error.
    }
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
