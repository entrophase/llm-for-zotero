import { getClaudeProfileSignature } from "../claudeCode/projectSkills";
import {
  DSH_GLOBAL_CONVERSATION_KEY_BASE,
  DSH_PAPER_CONVERSATION_KEY_BASE,
  buildDefaultConversationKey,
  getConversationKeyRange,
  getRuntimeAllocatedConversationKeyRange,
  getRuntimeDefaultConversationKeyRange,
  isConversationKeyFor,
} from "../shared/conversationKeySpace";

export { DSH_GLOBAL_CONVERSATION_KEY_BASE, DSH_PAPER_CONVERSATION_KEY_BASE };
export const DSH_HISTORY_LIMIT = 200;

/**
 * An empty selection preserves DSH's own default from ACP configOptions.
 */
export const DEFAULT_DSH_RUNTIME_MODEL = "";

// Filled from ACP configOptions; values are opaque runtime identifiers.
export type DshEffortMode = string;

export function getDshProfileSignature(): string {
  return getClaudeProfileSignature();
}

export function getDshGlobalConversationKeyRange(): {
  start: number;
  endExclusive: number;
} {
  return getConversationKeyRange("dsh", "global", getDshProfileSignature());
}

export function getDshPaperConversationKeyRange(): {
  start: number;
  endExclusive: number;
} {
  return getConversationKeyRange("dsh", "paper", getDshProfileSignature());
}

export function getDshDefaultConversationKeyRange(kind: "global" | "paper"): {
  start: number;
  endExclusive: number;
} {
  return getRuntimeDefaultConversationKeyRange(
    "dsh",
    kind,
    getDshProfileSignature(),
  );
}

export function getDshAllocatedConversationKeyRange(kind: "global" | "paper"): {
  start: number;
  endExclusive: number;
} {
  return getRuntimeAllocatedConversationKeyRange(
    "dsh",
    kind,
    getDshProfileSignature(),
  );
}

export function buildDefaultDshGlobalConversationKey(
  libraryID: number,
): number {
  return buildDefaultConversationKey(
    "dsh",
    "global",
    libraryID,
    getDshProfileSignature(),
  );
}

export function buildDefaultDshPaperConversationKey(
  paperItemID: number,
): number {
  return buildDefaultConversationKey(
    "dsh",
    "paper",
    paperItemID,
    getDshProfileSignature(),
  );
}

export function isDshConversationKey(conversationKey: number): boolean {
  return isConversationKeyFor("dsh", conversationKey);
}
