import { config } from "../../package.json";
import {
  DEFAULT_DSH_RUNTIME_MODEL,
  getDshAllocatedConversationKeyRange,
  getDshGlobalConversationKeyRange,
  getDshPaperConversationKeyRange,
  getDshProfileSignature,
  type DshEffortMode,
} from "./constants";
import { buildDshLibraryStateKey } from "./state";
import {
  forgetPaperRestoreTarget,
  getPaperRestoreTarget,
  rememberPaperRestoreTarget,
} from "../shared/paperConversationRestore";

type ZoteroPrefsAPI = {
  get?: (key: string, global?: boolean) => unknown;
  set?: (key: string, value: unknown, global?: boolean) => void;
};

function getZoteroPrefs(): ZoteroPrefsAPI | null {
  return (
    (globalThis as typeof globalThis & { Zotero?: { Prefs?: ZoteroPrefsAPI } })
      .Zotero?.Prefs || null
  );
}

function prefKey(key: string): string {
  return `${config.prefsPrefix}.${key}`;
}

function getStringPref(key: string): string {
  const value = getZoteroPrefs()?.get?.(prefKey(key), true);
  return typeof value === "string" ? value : "";
}

function setPref(key: string, value: unknown): void {
  getZoteroPrefs()?.set?.(prefKey(key), value, true);
}

function getJsonPref(key: string): Record<string, number> {
  const raw = getStringPref(key).trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const normalized: Record<string, number> = {};
    for (const [entryKey, entryValue] of Object.entries(parsed)) {
      const n = Number(entryValue);
      if (!Number.isFinite(n) || n <= 0) continue;
      normalized[entryKey] = Math.floor(n);
    }
    return normalized;
  } catch {
    return {};
  }
}

function setJsonPref(key: string, value: Record<string, number>): void {
  setPref(key, JSON.stringify(value));
}

function getJsonStringPref(key: string): Record<string, string> {
  const raw = getStringPref(key).trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const normalized: Record<string, string> = {};
    for (const [entryKey, entryValue] of Object.entries(parsed)) {
      if (typeof entryValue !== "string") continue;
      const trimmed = entryValue.trim();
      if (trimmed) normalized[entryKey] = trimmed;
    }
    return normalized;
  } catch {
    return {};
  }
}

function setJsonStringPref(key: string, value: Record<string, string>): void {
  setPref(key, JSON.stringify(value));
}

export function isDshModeEnabled(): boolean {
  const value = getZoteroPrefs()?.get?.(prefKey("enableDshMode"), true);
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    return value.trim().toLowerCase() === "true";
  }
  return false;
}

export function setDshModeEnabled(enabled: boolean): void {
  setPref("enableDshMode", Boolean(enabled));
}

export function getDshRuntimeModelPref(): string {
  return getStringPref("dshModel").trim() || DEFAULT_DSH_RUNTIME_MODEL;
}

export function setDshRuntimeModelPref(model: string): void {
  setPref("dshModel", model.trim());
}

export function getDshEffortPref(): DshEffortMode {
  return getStringPref("dshEffort").trim() || "auto";
}

export function setDshEffortPref(mode: DshEffortMode): void {
  setPref("dshEffort", mode);
}

export function getDshBinaryPathPref(): string {
  return getStringPref("dshPath").trim();
}

export function setDshBinaryPathPref(path: string): void {
  setPref("dshPath", path.trim());
}

export function getDshNodePathPref(): string {
  return getStringPref("dshNodePath").trim();
}
export function setDshNodePathPref(path: string): void {
  setPref("dshNodePath", path.trim());
}
export function getDshHomePref(): string {
  return getStringPref("dshHome").trim();
}
export function setDshHomePref(path: string): void {
  setPref("dshHome", path.trim());
}

function buildGlobalConversationMapKey(libraryID: number): string {
  return buildDshLibraryStateKey(libraryID);
}

export function getLastUsedDshConversationMode(
  libraryID: number,
): "global" | "paper" | null {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return null;
  const map = getJsonStringPref("dshConversationModeMap");
  const value = map[buildGlobalConversationMapKey(libraryID)];
  return value === "global" || value === "paper" ? value : null;
}

export function setLastUsedDshConversationMode(
  libraryID: number,
  mode: "global" | "paper",
): void {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return;
  const map = getJsonStringPref("dshConversationModeMap");
  map[buildGlobalConversationMapKey(libraryID)] =
    mode === "paper" ? "paper" : "global";
  setJsonStringPref("dshConversationModeMap", map);
}

export function removeLastUsedDshConversationMode(libraryID: number): void {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return;
  const map = getJsonStringPref("dshConversationModeMap");
  delete map[buildGlobalConversationMapKey(libraryID)];
  setJsonStringPref("dshConversationModeMap", map);
}

export function isConversationKeyInRange(
  value: number,
  kind: "global" | "paper",
): boolean {
  if (!Number.isFinite(value) || value <= 0) return false;
  const range =
    kind === "global"
      ? getDshGlobalConversationKeyRange()
      : getDshPaperConversationKeyRange();
  return value >= range.start && value < range.endExclusive;
}

function isConversationKeyInAllocatedRange(
  value: number,
  kind: "global" | "paper",
): boolean {
  if (!Number.isFinite(value) || value <= 0) return false;
  const range = getDshAllocatedConversationKeyRange(kind);
  return value >= range.start && value < range.endExclusive;
}

export function getLastUsedDshGlobalConversationKey(
  libraryID: number,
): number | null {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return null;
  const map = getJsonPref("dshGlobalConversationMap");
  const value = Number(map[buildGlobalConversationMapKey(libraryID)]);
  if (!Number.isFinite(value) || value <= 0) return null;
  return isConversationKeyInRange(value, "global") ? Math.floor(value) : null;
}

export function setLastUsedDshGlobalConversationKey(
  libraryID: number,
  conversationKey: number,
): void {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return;
  if (!Number.isFinite(conversationKey) || conversationKey <= 0) return;
  if (!isConversationKeyInRange(conversationKey, "global")) return;
  const map = getJsonPref("dshGlobalConversationMap");
  map[buildGlobalConversationMapKey(libraryID)] = Math.floor(conversationKey);
  setJsonPref("dshGlobalConversationMap", map);
}

export function removeLastUsedDshGlobalConversationKey(
  libraryID: number,
): void {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return;
  const map = getJsonPref("dshGlobalConversationMap");
  delete map[buildGlobalConversationMapKey(libraryID)];
  setJsonPref("dshGlobalConversationMap", map);
}

export function getLastUsedDshPaperConversationKey(
  libraryID: number,
  paperItemID: number,
): number | null {
  return getPaperRestoreTarget({
    system: "dsh",
    libraryID,
    paperItemID,
  });
}

export function setLastUsedDshPaperConversationKey(
  libraryID: number,
  paperItemID: number,
  conversationKey: number,
): void {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return;
  if (!Number.isFinite(paperItemID) || paperItemID <= 0) return;
  if (!Number.isFinite(conversationKey) || conversationKey <= 0) return;
  if (!isConversationKeyInRange(conversationKey, "paper")) return;
  rememberPaperRestoreTarget(
    { system: "dsh", libraryID, paperItemID },
    conversationKey,
  );
}

export function removeLastUsedDshPaperConversationKey(
  libraryID: number,
  paperItemID: number,
): void {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return;
  if (!Number.isFinite(paperItemID) || paperItemID <= 0) return;
  forgetPaperRestoreTarget({ system: "dsh", libraryID, paperItemID });
}

function buildLastAllocatedMapKey(kind: "global" | "paper"): string {
  return `${getDshProfileSignature()}:${kind}`;
}

function getLastAllocatedConversationKey(
  kind: "global" | "paper",
): number | null {
  const map = getJsonPref("dshLastAllocatedConversationKeyMap");
  const value = Number(map[buildLastAllocatedMapKey(kind)]);
  return Number.isFinite(value) &&
    isConversationKeyInAllocatedRange(value, kind)
    ? Math.floor(value)
    : null;
}

function setLastAllocatedConversationKey(
  kind: "global" | "paper",
  conversationKey: number,
): void {
  if (!Number.isFinite(conversationKey) || conversationKey <= 0) return;
  if (!isConversationKeyInAllocatedRange(conversationKey, kind)) return;
  const normalized = Math.floor(conversationKey);
  if (normalized <= (getLastAllocatedConversationKey(kind) || 0)) return;
  const map = getJsonPref("dshLastAllocatedConversationKeyMap");
  map[buildLastAllocatedMapKey(kind)] = normalized;
  setJsonPref("dshLastAllocatedConversationKeyMap", map);
}

export function getLastAllocatedDshGlobalConversationKey(): number | null {
  return getLastAllocatedConversationKey("global");
}

export function setLastAllocatedDshGlobalConversationKey(
  conversationKey: number,
): void {
  setLastAllocatedConversationKey("global", conversationKey);
}

export function getLastAllocatedDshPaperConversationKey(): number | null {
  return getLastAllocatedConversationKey("paper");
}

export function setLastAllocatedDshPaperConversationKey(
  conversationKey: number,
): void {
  setLastAllocatedConversationKey("paper", conversationKey);
}
