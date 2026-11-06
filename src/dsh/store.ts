import { cancelDshConversation } from "./lifecycle";
import {
  withConversationWriteLock,
  bumpConversationWriteGeneration,
} from "../shared/conversationWriteFence";
import {
  DSH_HISTORY_LIMIT,
  buildDefaultDshGlobalConversationKey,
  buildDefaultDshPaperConversationKey,
  getDshAllocatedConversationKeyRange,
  getDshProfileSignature,
} from "./constants";
import {
  getLastAllocatedDshGlobalConversationKey,
  getLastAllocatedDshPaperConversationKey,
  isConversationKeyInRange,
  setLastAllocatedDshGlobalConversationKey,
  setLastAllocatedDshPaperConversationKey,
  setLastUsedDshConversationMode,
  setLastUsedDshGlobalConversationKey,
  setLastUsedDshPaperConversationKey,
} from "./prefs";
import { CONVERSATION_INSTANCE_ID_MIGRATION_IDS } from "../shared/conversationSchemaMigrations";
import { clearPersistedAgentConversationRowsInTransaction } from "../modules/contextPanel/agentConversationCleanup";
import { createRuntimeConversationStore } from "../services/providers/runtimeConversationStore";

/**
 * DSH owns inference history. The shared store holds the displayed transcript,
 * durable session binding and a generation that survives clearing and restart.
 */

const DSH_MESSAGES_TABLE = "llm_for_zotero_dsh_messages";
const DSH_MESSAGES_INDEX = "llm_for_zotero_dsh_messages_conversation_idx";
const DSH_MESSAGES_ID_INDEX = "llm_for_zotero_dsh_messages_conversation_id_idx";
const DSH_CONVERSATIONS_TABLE = "llm_for_zotero_dsh_conversations";
const DSH_CONVERSATIONS_KIND_INDEX =
  "llm_for_zotero_dsh_conversations_kind_idx";
const DSH_CONVERSATIONS_ACTIVITY_INDEX =
  "llm_for_zotero_dsh_conversations_activity_idx";
const DSH_CONVERSATIONS_ID_INDEX = "llm_for_zotero_dsh_conversations_id_idx";

const store = createRuntimeConversationStore({
  system: "dsh",
  storeLabel: "DSH",
  startupStoreID: "dsh",
  instanceIdMigrationID: CONVERSATION_INSTANCE_ID_MIGRATION_IDS.dsh,
  schemaRevision: 1,
  tables: {
    messages: DSH_MESSAGES_TABLE,
    messagesIndex: DSH_MESSAGES_INDEX,
    messagesIdIndex: DSH_MESSAGES_ID_INDEX,
    catalog: DSH_CONVERSATIONS_TABLE,
    kindIndex: DSH_CONVERSATIONS_KIND_INDEX,
    activityIndex: DSH_CONVERSATIONS_ACTIVITY_INDEX,
    idIndex: DSH_CONVERSATIONS_ID_INDEX,
  },
  historyLimit: DSH_HISTORY_LIMIT,
  activityTimestampSqlForAliasC:
    "COALESCE(c.last_activity_at, c.updated_at, c.created_at)",
  extraCatalogColumns: [
    ["runtime_binding", "runtime_binding TEXT"],
    ["runtime_generation", "runtime_generation TEXT NOT NULL DEFAULT '0'"],
  ],
  registryRepairUserTurnCountSql: "COALESCE(c.user_turn_count, 0)",
  summaryExtraColumns: [
    { sql: "c.runtime_binding", alias: "runtimeBinding" },
    { sql: "c.runtime_generation", alias: "runtimeGeneration" },
  ],
  clearAgentConversationRowsInTransaction:
    clearPersistedAgentConversationRowsInTransaction,
  upsertExtraColumns: [{ column: "runtime_binding", param: "runtimeBinding" }],
  profileSignature: getDshProfileSignature,
  sessionResetColumns: ["runtime_binding"],
  sessionResetAssignments: [
    "runtime_generation = CAST(runtime_generation AS INTEGER) + 1",
  ],
  keys: {
    buildDefaultGlobalKey: buildDefaultDshGlobalConversationKey,
    buildDefaultPaperKey: buildDefaultDshPaperConversationKey,
    isInRange: isConversationKeyInRange,
    allocatedRange: getDshAllocatedConversationKeyRange,
  },
  prefs: {
    getLastAllocatedGlobal: getLastAllocatedDshGlobalConversationKey,
    getLastAllocatedPaper: getLastAllocatedDshPaperConversationKey,
    setLastUsedMode: setLastUsedDshConversationMode,
    setLastUsedGlobal: setLastUsedDshGlobalConversationKey,
    setLastAllocatedGlobal: setLastAllocatedDshGlobalConversationKey,
    setLastAllocatedPaper: setLastAllocatedDshPaperConversationKey,
    setLastUsedPaper: setLastUsedDshPaperConversationKey,
  },
});

export async function repairDshConversationIdentityRegistry(
  ...args: Parameters<typeof store.repairConversationIdentityRegistry>
) {
  return store.repairConversationIdentityRegistry(...args);
}

export const DSH_STORE_STARTUP_MIGRATION_IDS = store.startupMigrationIDs;

export async function initDshStore(
  ...args: Parameters<typeof store.initStore>
) {
  return store.initStore(...args);
}

export async function appendDshMessage(
  ...args: Parameters<typeof store.appendMessage>
) {
  return store.appendMessage(...args);
}

export async function loadDshConversation(
  ...args: Parameters<typeof store.loadConversation>
) {
  return store.loadConversation(...args);
}

export async function clearDshConversation(
  ...args: Parameters<typeof store.clearConversation>
) {
  cancelDshConversation(args[0]);
  bumpConversationWriteGeneration(args[0]);
  return withConversationWriteLock(args[0], () =>
    store.clearConversation(...args),
  );
}

export async function deleteDshTurnMessages(
  ...args: Parameters<typeof store.deleteTurnMessages>
) {
  return store.deleteTurnMessages(...args);
}

export async function pruneDshConversation(
  ...args: Parameters<typeof store.pruneConversation>
) {
  return store.pruneConversation(...args);
}

export async function updateLatestDshUserMessage(
  ...args: Parameters<typeof store.updateLatestUserMessage>
) {
  return store.updateLatestUserMessage(...args);
}

export async function updateLatestDshAssistantMessage(
  ...args: Parameters<typeof store.updateLatestAssistantMessage>
) {
  return store.updateLatestAssistantMessage(...args);
}

export async function updateDshAssistantMessageQuoteLocations(
  ...args: Parameters<typeof store.updateAssistantMessageQuoteLocations>
) {
  return store.updateAssistantMessageQuoteLocations(...args);
}

export async function getDshConversationSummary(
  ...args: Parameters<typeof store.getSummary>
) {
  return store.getSummary(...args);
}

export async function upsertDshConversationSummary(
  ...args: Parameters<typeof store.upsertSummary>
) {
  return store.upsertSummary(...args);
}

export async function listDshGlobalConversations(
  ...args: Parameters<typeof store.listGlobalConversations>
) {
  return store.listGlobalConversations(...args);
}

export async function listDshPaperConversations(
  ...args: Parameters<typeof store.listPaperConversations>
) {
  return store.listPaperConversations(...args);
}

export async function listAllDshPaperConversationsByLibrary(
  ...args: Parameters<typeof store.listAllPaperConversationsByLibrary>
) {
  return store.listAllPaperConversationsByLibrary(...args);
}

export async function ensureDshGlobalConversation(
  ...args: Parameters<typeof store.ensureGlobalConversation>
) {
  return store.ensureGlobalConversation(...args);
}

export async function ensureDshPaperConversation(
  ...args: Parameters<typeof store.ensurePaperConversation>
) {
  return store.ensurePaperConversation(...args);
}

export async function createDshGlobalConversation(
  ...args: Parameters<typeof store.createGlobalConversation>
) {
  return store.createGlobalConversation(...args);
}

export async function createDshPaperConversation(
  ...args: Parameters<typeof store.createPaperConversation>
) {
  return store.createPaperConversation(...args);
}

export async function touchDshConversationTitle(
  ...args: Parameters<typeof store.touchConversationTitle>
) {
  return store.touchConversationTitle(...args);
}

export async function clearDshConversationSessionMetadata(
  ...args: Parameters<typeof store.clearConversationSessionMetadata>
) {
  cancelDshConversation(args[0]);
  return store.clearConversationSessionMetadata(...args);
}

export async function setDshConversationTitle(
  ...args: Parameters<typeof store.setConversationTitle>
) {
  return store.setConversationTitle(...args);
}

export async function deleteDshConversation(
  ...args: Parameters<typeof store.deleteConversation>
) {
  cancelDshConversation(args[0]);
  return store.deleteConversation(...args);
}

export async function preflightDeleteDshConversationLocalRows(
  ...args: Parameters<typeof store.preflightDeleteConversationLocalRows>
) {
  return store.preflightDeleteConversationLocalRows(...args);
}

export async function deleteDshConversationLocalRows(
  ...args: Parameters<typeof store.deleteConversationLocalRows>
) {
  cancelDshConversation(args[0]);
  return store.deleteConversationLocalRows(...args);
}
