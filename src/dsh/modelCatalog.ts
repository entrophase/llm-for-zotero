import type { RuntimeModelEntry } from "../utils/modelProviders";
import { getDshProcess, resolveDshLaunch, joinDshPath } from "./process";
import { getUserSkillsRuntimeRootDir } from "../agent/skills/userSkills";
import { ensureDir } from "../utils/geckoFs";
import { configChoices, type AcpConfigOption } from "./protocol";
import { getDshRuntimeModelPref } from "./prefs";
type DshModel = { id: string; label: string };

export const DSH_RUNTIME_PROVIDER_LABEL = "DSH";
const DSH_RUNTIME_GROUP_ID = "dsh-runtime";
const DSH_RUNTIME_ENTRY_PREFIX = "dsh";

/** Local menu sentinel; an empty preference uses the session's DSH default. */
export const DSH_DEFAULT_MODEL_ID = "default";

export function toDshModelPref(entryModel: string): string {
  const model = entryModel.trim();
  return model === DSH_DEFAULT_MODEL_ID ? "" : model;
}

function createRuntimeModelEntry(params: {
  model: string;
  displayName: string;
  providerOrder: number;
}): RuntimeModelEntry {
  return {
    entryId: `${DSH_RUNTIME_ENTRY_PREFIX}::${params.model}`,
    groupId: DSH_RUNTIME_GROUP_ID,
    model: params.model,
    // The shared model picker requires a non-empty base for local runtimes.
    apiBase: "dsh-cli://local",
    apiKey: "",
    authMode: "api_key",
    providerProtocol: "openai_chat_compat",
    providerLabel: DSH_RUNTIME_PROVIDER_LABEL,
    providerOrder: params.providerOrder,
    displayModelLabel: params.displayName || params.model,
    advanced: {
      temperature: 0.7,
      outputTokenLimit: { mode: "auto" },
    },
  };
}

/** Models come from ACP configOptions; retain a saved selection for display. */
export function buildDshRuntimeModelEntries(params: {
  models: DshModel[];
  selectedModel: string;
}): RuntimeModelEntry[] {
  const entries: RuntimeModelEntry[] = [
    createRuntimeModelEntry({
      model: DSH_DEFAULT_MODEL_ID,
      displayName: "DSH default",
      providerOrder: -2,
    }),
  ];
  const seen = new Set<string>([DSH_DEFAULT_MODEL_ID]);
  const selected = params.selectedModel.trim();
  if (selected && !params.models.some((model) => model.id === selected)) {
    entries.push(
      createRuntimeModelEntry({
        model: selected,
        displayName: selected,
        providerOrder: -1,
      }),
    );
    seen.add(selected);
  }
  for (const [index, model] of params.models.entries()) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    entries.push(
      createRuntimeModelEntry({
        model: model.id,
        displayName: model.label,
        providerOrder: index,
      }),
    );
  }
  return entries;
}

export function selectDshRuntimeEntry(
  entries: RuntimeModelEntry[],
  selectedModel: string,
): RuntimeModelEntry {
  const wanted = selectedModel.trim() || DSH_DEFAULT_MODEL_ID;
  return entries.find((entry) => entry.model === wanted) || entries[0]!;
}

let configOptions: AcpConfigOption[] = [];
let status: "idle" | "loading" | "ready" | "error" = "idle";
let error = "";
let identity = "";
let inFlight: Promise<DshModel[]> | null = null;
export function updateDshConfigOptions(options: AcpConfigOption[]): void {
  configOptions = options;
  status = "ready";
  error = "";
}
export function getDshModelCatalogSnapshot() {
  return {
    status,
    error,
    models: configChoices(
      configOptions.find((o) => o.category === "model"),
    ).map((o) => ({ id: o.value, label: o.name })),
  };
}
export function getDshReasoningChoices(): Array<{
  value: string;
  label: string;
}> {
  return [
    { value: "auto", label: "DSH default" },
    ...configChoices(
      configOptions.find((o) => o.category === "thought_level"),
    ).map((o) => ({ value: o.value, label: o.name })),
  ];
}
export async function loadDshModelCatalog(
  _binaryPath = "",
  options: { force?: boolean } = {},
): Promise<DshModel[]> {
  let launch;
  try {
    launch = await resolveDshLaunch();
  } catch (reason) {
    status = "error";
    error = String(reason instanceof Error ? reason.message : reason);
    return getDshModelCatalogSnapshot().models;
  }
  const key = launch.identity + getDshRuntimeModelPref();
  if (!options.force && identity === key && status === "ready")
    return getDshModelCatalogSnapshot().models;
  if (inFlight) return inFlight;
  identity = key;
  status = "loading";
  error = "";
  inFlight = (async () => {
    const { rpc } = await getDshProcess(launch);
    const cwd = joinDshPath(getUserSkillsRuntimeRootDir(), "dsh", "catalog");
    if (!(await ensureDir(cwd)))
      throw new Error("Cannot create DSH catalog workspace");
    const session = await rpc
      .request("session/new", { cwd, mcpServers: [] }, 180_000)
      .catch((reason) => {
        if (String(reason).includes("timed out")) rpc.close();
        throw reason;
      });
    try {
      let values: AcpConfigOption[] = session.configOptions || [];
      const model = values.find((o) => o.category === "model");
      const selected = getDshRuntimeModelPref();
      if (
        model &&
        selected &&
        configChoices(model).some((o) => o.value === selected)
      ) {
        values = (
          await rpc.request("session/set_config_option", {
            sessionId: session.sessionId,
            configId: model.id,
            value: selected,
          })
        ).configOptions;
      }
      updateDshConfigOptions(values || []);
      return getDshModelCatalogSnapshot().models;
    } finally {
      try {
        await rpc.request(
          "session/close",
          { sessionId: session.sessionId },
          10_000,
        );
      } catch {
        rpc.close();
      }
    }
  })()
    .catch((reason) => {
      status = "error";
      error = String(reason instanceof Error ? reason.message : reason);
      return getDshModelCatalogSnapshot().models;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}
