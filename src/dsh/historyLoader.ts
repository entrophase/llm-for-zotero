import {
  conversationRepository,
  type ConversationCatalogEntry,
} from "../core/conversations/repository";

export type DshConversationHistoryEntry = {
  conversationID: string;
  conversationKey: number;
  kind: "global" | "paper";
  title: string;
  createdAt: number;
  lastActivityAt: number;
  userTurnCount: number;
  isDraft: boolean;
  paperItemID?: number;
  providerSessionId?: string;
  scopedConversationKey?: string;
};

function normalizeTitle(summary: ConversationCatalogEntry): string {
  const title = (summary.title || "").trim();
  if (title) return title;
  return summary.kind === "paper" ? "New DSH paper chat" : "New DSH chat";
}

function isDraftSummary(summary: ConversationCatalogEntry): boolean {
  const userTurnCount = Number(summary.userTurnCount || 0);
  return (
    userTurnCount <= 0 &&
    !summary.title?.trim() &&
    !summary.providerSessionId?.trim() &&
    !summary.scopedConversationKey?.trim()
  );
}

function toEntry(
  summary: ConversationCatalogEntry,
): DshConversationHistoryEntry {
  const isDraft = isDraftSummary(summary);
  return {
    conversationID: summary.conversationID,
    conversationKey: summary.conversationKey,
    kind: summary.kind,
    title: normalizeTitle(summary),
    createdAt: summary.createdAt,
    lastActivityAt: summary.lastActivityAt,
    userTurnCount: summary.userTurnCount,
    isDraft,
    paperItemID: summary.paperItemID,
    providerSessionId: summary.providerSessionId,
    scopedConversationKey: summary.scopedConversationKey,
  };
}

export async function loadDshConversationHistoryScope(params: {
  libraryID: number;
  kind: "global" | "paper";
  paperItemID?: number;
  limit?: number;
}): Promise<DshConversationHistoryEntry[]> {
  const summaries = await conversationRepository.listCatalogEntries({
    system: "dsh",
    libraryID: params.libraryID,
    kind: params.kind,
    paperItemID: params.paperItemID,
    limit: params.limit,
  });
  return summaries.map(toEntry);
}

export async function loadAllDshConversationHistory(params: {
  libraryID: number;
  limit?: number | null;
}): Promise<DshConversationHistoryEntry[]> {
  const normalizedLimit =
    params.limit === null
      ? null
      : Number.isFinite(params.limit)
        ? Math.max(1, Math.floor(params.limit as number))
        : 100;
  return (
    await conversationRepository.listAllCatalogEntries({
      system: "dsh",
      libraryID: params.libraryID,
      limit: normalizedLimit,
    })
  ).map(toEntry);
}
