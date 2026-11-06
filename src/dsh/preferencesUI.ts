import { config } from "../../package.json";
import * as prefs from "./prefs";
import { applyDshModePreferenceChange } from "./modePreference";
import {
  getDshModelCatalogSnapshot,
  getDshReasoningChoices,
  loadDshModelCatalog,
} from "./modelCatalog";
import { testDshConnection } from "./diagnostics";

export function bindDshPreferences(doc: Document): void {
  const find = <T extends HTMLElement>(id: string) =>
    doc.getElementById(`${config.addonRef}-dsh-${id}`) as T | null;
  const enabled = find<HTMLInputElement>("enable");
  const settings = find<HTMLDivElement>("settings");
  const model = find<HTMLSelectElement>("model");
  const effort = find<HTMLSelectElement>("effort");
  const status = find<HTMLSpanElement>("status");
  const report = (text: string) => {
    if (status) status.textContent = text;
  };
  const syncEnabled = () => {
    const summary = doc.querySelector('[data-llm-row-summary="dsh"]');
    if (summary)
      summary.textContent = prefs.isDshModeEnabled()
        ? "Enabled · Official ACP"
        : "Disabled";
    if (enabled) enabled.checked = prefs.isDshModeEnabled();
    if (settings)
      settings.style.display = prefs.isDshModeEnabled() ? "flex" : "none";
  };
  syncEnabled();
  enabled?.addEventListener("change", () => {
    applyDshModePreferenceChange(enabled.checked);
    syncEnabled();
  });
  for (const [id, get, set] of [
    ["path", prefs.getDshBinaryPathPref, prefs.setDshBinaryPathPref],
    ["node", prefs.getDshNodePathPref, prefs.setDshNodePathPref],
    ["home", prefs.getDshHomePref, prefs.setDshHomePref],
  ] as const) {
    const input = find<HTMLInputElement>(id);
    if (input) {
      input.value = get();
      input.addEventListener("change", () => set(input.value));
    }
  }
  const populate = (
    select: HTMLSelectElement | null,
    choices: Array<{ value: string; label: string }>,
    selected: string,
  ) => {
    if (!select) return;
    select.replaceChildren();
    for (const choice of choices) {
      const option = doc.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "option",
      ) as HTMLOptionElement;
      option.value = choice.value;
      option.textContent = choice.label;
      select.append(option);
    }
    select.value = choices.some((c) => c.value === selected)
      ? selected
      : choices[0]?.value || "";
  };
  const render = () => {
    const catalog = getDshModelCatalogSnapshot();
    populate(
      model,
      [
        { value: "", label: "DSH default" },
        ...catalog.models.map((m) => ({ value: m.id, label: m.label })),
      ],
      prefs.getDshRuntimeModelPref(),
    );
    populate(effort, getDshReasoningChoices(), prefs.getDshEffortPref());
  };
  const refresh = async () => {
    report("Loading DSH model options…");
    try {
      await loadDshModelCatalog(prefs.getDshBinaryPathPref(), { force: true });
      render();
      const snapshot = getDshModelCatalogSnapshot();
      report(snapshot.error || "Model options loaded from DSH.");
    } catch (error) {
      report(String(error));
    }
  };
  render();
  find<HTMLButtonElement>("refresh")?.addEventListener("click", () => {
    void refresh();
  });
  model?.addEventListener("change", () => {
    prefs.setDshRuntimeModelPref(model.value);
    prefs.setDshEffortPref("auto");
    void refresh();
  });
  effort?.addEventListener("change", () =>
    prefs.setDshEffortPref(effort.value),
  );
  for (const [id, modelTest] of [
    ["test", false],
    ["test-model", true],
  ] as const) {
    const button = find<HTMLButtonElement>(id);
    button?.addEventListener("click", () => {
      button.disabled = true;
      report("Connecting to DSH…");
      void testDshConnection(modelTest, report)
        .catch((error) => report(String(error)))
        .finally(() => {
          button.disabled = false;
          render();
        });
    });
  }
}
