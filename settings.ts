import {
  getSettingsListTheme,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type SettingItem,
  SettingsList,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { getIPythonConfigPath, type IPythonConfig } from "./config.ts";

type BooleanConfigKey = Exclude<keyof IPythonConfig, "maxOutputChars">;

const BOOLEAN_SETTINGS: Array<{
  key: BooleanConfigKey;
  label: string;
  description: string;
}> = [
  {
    key: "enabled",
    label: "Extension",
    description:
      "Expose the ipython tool and add its notebook guidance to the system prompt.",
  },
  {
    key: "disableBuiltins",
    label: "Disable built-in tools",
    description:
      "Use IPython as the primary control surface by hiding Pi's native file and shell tools.",
  },
  {
    key: "restoreState",
    label: "Restore namespace",
    description:
      "Restore the latest dill snapshot when the kernel first starts in this directory.",
  },
  {
    key: "snapshotState",
    label: "Snapshot namespace",
    description:
      "Persist a best-effort namespace snapshot after settled user cells and at shutdown.",
  },
  {
    key: "exportNotebook",
    label: "Export notebook",
    description: "Write kernel-notebook.ipynb when the session shuts down.",
  },
  {
    key: "showOutputWhenCollapsed",
    label: "Collapsed output",
    description:
      "Show captured output in collapsed tool rows; expanded rows always show it.",
  },
];

const OUTPUT_LIMITS = new Map([
  ["16 KiB", 16 * 1024],
  ["64 KiB", 64 * 1024],
  ["256 KiB", 256 * 1024],
]);

function outputLimitLabel(value: number): string {
  for (const [label, characters] of OUTPUT_LIMITS) {
    if (characters === value) return label;
  }
  return "64 KiB";
}

function buildItems(config: IPythonConfig): SettingItem[] {
  return [
    ...BOOLEAN_SETTINGS.map(({ key, label, description }) => ({
      id: key,
      label,
      description,
      currentValue: config[key] ? "on" : "off",
      values: ["off", "on"],
    })),
    {
      id: "maxOutputChars",
      label: "Output limit",
      description:
        "Maximum captured characters per stdout, stderr, and result field.",
      currentValue: outputLimitLabel(config.maxOutputChars),
      values: [...OUTPUT_LIMITS.keys()],
    },
  ];
}

function updateConfig(
  config: IPythonConfig,
  id: string,
  value: string,
): IPythonConfig {
  if (id === "maxOutputChars") {
    return {
      ...config,
      maxOutputChars: OUTPUT_LIMITS.get(value) ?? config.maxOutputChars,
    };
  }
  const setting = BOOLEAN_SETTINGS.find(({ key }) => key === id);
  return setting ? { ...config, [setting.key]: value === "on" } : config;
}

function rule(width: number, theme: Theme, color: "accent" | "borderMuted") {
  return theme.fg(color, "─".repeat(Math.max(0, width)));
}

export function formatIPythonSettings(config: IPythonConfig): string {
  return [
    `extension ${config.enabled ? "on" : "off"}`,
    `built-ins ${config.disableBuiltins ? "disabled" : "enabled"}`,
    `restore ${config.restoreState ? "on" : "off"}`,
    `snapshot ${config.snapshotState ? "on" : "off"}`,
    `notebook export ${config.exportNotebook ? "on" : "off"}`,
    `collapsed output ${config.showOutputWhenCollapsed ? "on" : "off"}`,
    `output limit ${outputLimitLabel(config.maxOutputChars)}`,
  ].join(", ");
}

export async function openIPythonSettings(
  ctx: ExtensionContext,
  initialConfig: IPythonConfig,
  onChange: (config: IPythonConfig) => IPythonConfig | undefined,
): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify(
      `Pithon settings: ${formatIPythonSettings(initialConfig)}`,
      "info",
    );
    return;
  }

  let config = initialConfig;
  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    const settings = new SettingsList(
      buildItems(config),
      9,
      getSettingsListTheme(),
      (id, value) => {
        const previous = config;
        const next = updateConfig(config, id, value);
        const applied = onChange(next);
        if (applied) {
          config = applied;
          for (const item of buildItems(config)) {
            settings.updateValue(item.id, item.currentValue);
          }
        } else {
          const previousItem = buildItems(previous).find(
            (item) => item.id === id,
          );
          if (previousItem) settings.updateValue(id, previousItem.currentValue);
        }
        tui.requestRender();
      },
      () => done(undefined),
    );

    return {
      render(width: number) {
        return [
          rule(width, theme, "accent"),
          `  ${theme.bold("Pithon settings")}`,
          rule(width, theme, "borderMuted"),
          "",
          ...settings.render(width),
          "",
          theme.fg("dim", `  ${getIPythonConfigPath()}`),
          rule(width, theme, "accent"),
        ].map((line) => truncateToWidth(line, width, ""));
      },
      invalidate() {
        settings.invalidate();
      },
      handleInput(data: string) {
        settings.handleInput?.(data);
        tui.requestRender();
      },
    };
  });
}
