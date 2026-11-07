import type {
  ChatMessage,
  ModelTurnOutcome,
  UsageStats,
  ReasoningConfig,
} from "../shared/llm";
import { getUserSkillsRuntimeRootDir } from "../agent/skills/userSkills";
import {
  areConversationWritesFrozen,
  getConversationWriteGeneration,
  isConversationWriteGenerationCurrent,
  withConversationWriteLock,
} from "../shared/conversationWriteFence";
import { createAbortController } from "../utils/apiHelpers";
import { appLogger } from "../core/logging";
import { getAntigravityProfileSignature } from "./constants";
import {
  activeAgyTurns,
  agySessions,
  agySessionsStopping,
  closeAgyConversation,
  scheduleAgyRelease,
  registerAgyShutdown,
  trackAgyStart,
  type AgySessionWorkspace,
  type RetainedAgySession,
} from "./sessionPool";
import {
  getAntigravityConversationSummary,
  upsertAntigravityConversationSummary,
} from "./store";
import {
  AGY_INLINE_PROMPT_LIMIT,
  AgyTextAccumulator,
  buildAgyFileContextPrompt,
  fingerprintSystemContext,
  splitAgyPrompt,
  toUsageStats,
} from "./agyStream";
import { ensureDir, removePathQuietly, writeFileBytes } from "../utils/geckoFs";
import {
  AgySessionUnavailableError,
  openAgySession,
  resolveAgyLaunch,
  runAgyTurn,
  type AgyTurnOptions,
} from "./agyProcess";
import { toAntigravityModelPref } from "./modelCatalog";
import {
  getAntigravityBinaryPathPref,
  getAntigravityEffortPref,
  getAntigravityPermissionModePref,
  getAntigravityRuntimeModelPref,
} from "./prefs";
import {
  registerScopedZoteroMcpScope,
  getZoteroMcpServerUrl,
  addZoteroMcpToolActivityObserver,
  type ZoteroMcpToolActivityEvent,
} from "../agent/mcp/server";
import type {
  AgentPendingAction,
  AgentConfirmationResolution,
  AgentRuntimeRequest,
} from "../agent/types";
import { createJournalId } from "../agent/store/changeJournal";
import type { TurnPaperScope } from "../agent/context/turnPaperScope";
import type { AttachedConversationRef } from "../shared/types";

/**
 * The system context last sent into each agy conversation, by conversation
 * key. In memory only: after a restart the context is sent once more, which
 * costs tokens but never loses it.
 */
const sentSystemContextByConversation = new Map<number, string>();

export function forgetAntigravitySentContext(conversationKey: number): void {
  sentSystemContextByConversation.delete(conversationKey);
  void closeAgyConversation(conversationKey, true);
}

export function resolveAntigravityRuntimeCwd(): string | undefined {
  try {
    // The same root Codex uses: agy also discovers `.agents/skills` there.
    return getUserSkillsRuntimeRootDir();
  } catch {
    return undefined;
  }
}

export type AntigravityPanelTurn = {
  conversationKey: number;
  startedAt?: number;
  messages: ChatMessage[];
  model?: string;
  reasoning?: ReasoningConfig | string;
  attachedPastChatText?: string;
  signal?: AbortSignal;
  /**
   * Start a new agy conversation instead of resuming the stored one. A retry
   * or an edit rewrites history agy already holds, so it starts over with
   * the transcript the panel shows.
   */
  freshConversation?: boolean;
  libraryID?: number;
  paperItemID?: number;
  activeItemId?: number;
  turnPaperScope?: TurnPaperScope;
  executionRequest?: AgentRuntimeRequest;
  attachedConversationScope?: AttachedConversationRef[];
};

/** One tool step of an agy turn, as the panel's activity trace shows it. */
export type AntigravityActivity = {
  stepIndex: number;
  toolName: string;
  summary?: string;
  phase: "started" | "completed";
  failed: boolean;
};

export type AntigravityPanelCallbacks = {
  isLive: () => boolean;
  onDelta: (delta: string) => void;
  onStatus: (text: string) => void;
  onUsage?: (usage: UsageStats) => void;
  onActivity?: (activity: AntigravityActivity) => void;
  onMcpActivity?: (event: ZoteroMcpToolActivityEvent) => void;
  onHostInteraction?: (
    action: AgentPendingAction,
  ) => Promise<AgentConfirmationResolution>;
};

/** A step's state once it stopped running: done, or failed some way. */
function isFinishedStepState(state: string): boolean {
  return /^(DONE|COMPLETED?|SUCCESS|ERROR|FAILED|CANCELL?ED|DENIED)$/i.test(
    state,
  );
}

async function rememberConversationId(
  conversationKey: number,
  conversationId: string,
  expected?: { instanceID?: string; generation: number; profile: string },
): Promise<void> {
  if (!conversationId) return;
  await withConversationWriteLock(conversationKey, async () => {
    const summary = await getAntigravityConversationSummary(conversationKey);
    if (!summary || summary.providerSessionId === conversationId) return;
    if (
      expected &&
      (agySessionsStopping() ||
        summary.instanceID !== expected.instanceID ||
        areConversationWritesFrozen(conversationKey) ||
        !isConversationWriteGenerationCurrent(
          conversationKey,
          expected.generation,
        ) ||
        getAntigravityProfileSignature() !== expected.profile)
    )
      return;
    await upsertAntigravityConversationSummary({
      conversationKey: summary.conversationKey,
      instanceID: summary.instanceID,
      libraryID: summary.libraryID,
      kind: summary.kind,
      paperItemID: summary.paperItemID,
      createdAt: summary.createdAt,
      updatedAt: Date.now(),
      title: summary.title,
      providerSessionId: conversationId,
      scopedConversationKey: summary.scopedConversationKey,
      scopeType: summary.scopeType,
      scopeId: summary.scopeId,
      scopeLabel: summary.scopeLabel,
      cwd: summary.cwd,
      model: summary.model,
      effort: summary.effort,
    });
  });
}

function formatToolStatus(toolName: string, summary?: string): string {
  const label = toolName.replace(/_/g, " ").trim() || "a tool";
  return summary ? `Antigravity: ${summary}` : `Antigravity: using ${label}`;
}

/** A file holding a turn's context for agy to read, and its folder. */
export type AgyContextFile = { path: string; dir: string };

async function prepareAgySessionWorkspace(params: {
  conversationKey: number;
  scopeToken: string;
  mcpServerUrl: string;
}): Promise<AgySessionWorkspace | null> {
  const temp = (
    globalThis as { Zotero?: { getTempDirectory?: () => { path?: string } } }
  ).Zotero?.getTempDirectory?.()?.path?.trim();
  if (!temp) return null;
  const dir = joinLocalPath(
    temp,
    `llm-for-zotero-agy-session-${params.conversationKey}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const agentsDir = joinLocalPath(dir, ".agents");
  const mcpConfigPath = joinLocalPath(agentsDir, "mcp_config.json");
  const settingsPath = joinLocalPath(dir, "settings.json");

  try {
    if (!(await ensureDir(agentsDir))) {
      await removePathQuietly(dir);
      return null;
    }

    const mcpConfig = {
      mcpServers: {
        llm_for_zotero_antigravity: {
          url: params.mcpServerUrl,
          headers: {
            Authorization: `Bearer ${params.scopeToken}`,
            "X-LLM-For-Zotero-Scope": params.scopeToken,
          },
          timeoutSeconds: 600,
        },
      },
    };
    const mcpConfigBytes = new TextEncoder().encode(
      JSON.stringify(mcpConfig, null, 2),
    );
    if (!(await writeFileBytes(mcpConfigPath, mcpConfigBytes))) {
      await removePathQuietly(dir);
      return null;
    }

    const settings = {
      permissions: {
        allow: ["mcp(llm_for_zotero_antigravity/*)"],
      },
    };
    const settingsBytes = new TextEncoder().encode(
      JSON.stringify(settings, null, 2),
    );
    if (!(await writeFileBytes(settingsPath, settingsBytes))) {
      await removePathQuietly(dir);
      return null;
    }

    return { dir, settingsPath };
  } catch {
    await removePathQuietly(dir);
    return null;
  }
}

function joinLocalPath(...parts: string[]): string {
  const pathUtils = (
    globalThis as { PathUtils?: { join?: (...parts: string[]) => string } }
  ).PathUtils;
  return pathUtils?.join
    ? pathUtils.join(...parts)
    : parts.join("/").replace(/\/+/g, "/");
}

/**
 * Writes the context into its own folder under Zotero's temp directory, so
 * `--add-dir` opens that one file to agy and nothing else.
 */
async function writeAgyContextFile(
  text: string,
  workspace?: AgySessionWorkspace | null,
): Promise<AgyContextFile | null> {
  const temp =
    workspace?.dir ||
    (
      globalThis as { Zotero?: { getTempDirectory?: () => { path?: string } } }
    ).Zotero?.getTempDirectory?.()?.path?.trim();
  if (!temp) return null;
  const dir = joinLocalPath(
    temp,
    `llm-for-zotero-agy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const path = joinLocalPath(dir, "context.md");
  try {
    if (!(await ensureDir(dir))) return null;
    if (!(await writeFileBytes(path, new TextEncoder().encode(text)))) {
      await removePathQuietly(dir);
      return null;
    }
  } catch {
    await removePathQuietly(dir);
    return null;
  }
  return { path, dir };
}

export type AntigravityTurnDeps = {
  runTurn: (options: AgyTurnOptions) => ReturnType<typeof runAgyTurn>;
  getStoredConversationId: (conversationKey: number) => Promise<string>;
  rememberConversationId: (
    conversationKey: number,
    conversationId: string,
  ) => Promise<void>;
  writeContextFile: (
    text: string,
    workspace?: AgySessionWorkspace | null,
  ) => Promise<AgyContextFile | null>;
  removeContextFile: (file: AgyContextFile) => Promise<void>;
  readSettings: () => {
    binaryPath: string;
    model: string;
    effort: ReturnType<typeof getAntigravityEffortPref>;
    permissionMode: ReturnType<typeof getAntigravityPermissionModePref>;
    cwd?: string;
  };
  registerMcpScope?: typeof registerScopedZoteroMcpScope;
  getMcpServerUrl?: typeof getZoteroMcpServerUrl;
  prepareWorkspace?: (params: {
    conversationKey: number;
    scopeToken: string;
    mcpServerUrl: string;
  }) => Promise<AgySessionWorkspace | null>;
  removeWorkspace?: (workspace: AgySessionWorkspace) => Promise<void>;
};

const DEFAULT_TURN_DEPS: AntigravityTurnDeps = {
  runTurn: runAgyTurn,
  getStoredConversationId: async (conversationKey) =>
    (
      await getAntigravityConversationSummary(conversationKey)
    )?.providerSessionId?.trim() || "",
  rememberConversationId,
  writeContextFile: writeAgyContextFile,
  removeContextFile: (file) => removePathQuietly(file.dir),
  readSettings: () => ({
    binaryPath: getAntigravityBinaryPathPref(),
    model: getAntigravityRuntimeModelPref(),
    effort: getAntigravityEffortPref(),
    permissionMode: getAntigravityPermissionModePref(),
    cwd: resolveAntigravityRuntimeCwd(),
  }),
  registerMcpScope: registerScopedZoteroMcpScope,
  getMcpServerUrl: getZoteroMcpServerUrl,
  prepareWorkspace: prepareAgySessionWorkspace,
  removeWorkspace: (workspace) => removePathQuietly(workspace.dir),
};

/** One Antigravity turn from the panel, shared by the send and retry flows. */
export async function runAntigravityPanelTurn(
  turn: AntigravityPanelTurn,
  panel: AntigravityPanelCallbacks,
  overrides: Partial<AntigravityTurnDeps> = {},
): Promise<ModelTurnOutcome> {
  const persistent = !overrides.runTurn;
  const key = turn.conversationKey;
  if (!persistent) return executeAntigravityTurn(turn, panel, overrides, false);
  if (activeAgyTurns.has(key))
    throw new Error("Antigravity is already answering in this conversation.");
  registerAgyShutdown();
  const signal = turn.signal;
  const controller = createAbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  turn = { ...turn, signal: controller.signal };
  activeAgyTurns.set(key, cancel);
  try {
    try {
      return await executeAntigravityTurn(turn, panel, overrides, true);
    } catch (error) {
      if (!(error instanceof AgySessionUnavailableError)) throw error;
      return await executeAntigravityTurn(turn, panel, overrides, true);
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    activeAgyTurns.delete(key);
    scheduleAgyRelease(key);
  }
}

async function executeAntigravityTurn(
  turn: AntigravityPanelTurn,
  panel: AntigravityPanelCallbacks,
  overrides: Partial<AntigravityTurnDeps>,
  persistent: boolean,
): Promise<ModelTurnOutcome> {
  const key = turn.conversationKey;
  const timingStart = turn.startedAt ?? Date.now();
  const readyAt = Date.now();
  const deps = { ...DEFAULT_TURN_DEPS, ...overrides };
  const settings = deps.readSettings();
  const model =
    toAntigravityModelPref(turn.model ?? settings.model) || undefined;
  const generation =
    turn.executionRequest?.conversationGeneration ??
    getConversationWriteGeneration(key);
  const profile = persistent ? getAntigravityProfileSignature() : "";
  const assertCurrent = () => {
    if (
      turn.signal?.aborted ||
      (persistent &&
        (agySessionsStopping() ||
          areConversationWritesFrozen(key) ||
          !isConversationWriteGenerationCurrent(key, generation) ||
          getAntigravityProfileSignature() !== profile))
    ) {
      const error = new Error("Antigravity turn cancelled");
      error.name = "AbortError";
      throw error;
    }
  };
  assertCurrent();
  const summary = persistent
    ? await getAntigravityConversationSummary(key)
    : undefined;
  const expected = persistent
    ? { instanceID: summary?.instanceID, generation, profile }
    : undefined;
  const storedConversationId = turn.freshConversation
    ? ""
    : persistent
      ? summary?.providerSessionId?.trim() || ""
      : await deps.getStoredConversationId(key);
  const launch = persistent
    ? await resolveAgyLaunch(settings.binaryPath)
    : undefined;
  const mcpServerUrl = deps.getMcpServerUrl?.() || "";
  const binding = JSON.stringify([
    expected,
    launch,
    model,
    settings.effort,
    settings.permissionMode,
    settings.cwd,
    mcpServerUrl,
  ]);
  let retained = persistent ? agySessions.get(key) : undefined;
  if (
    persistent &&
    (!retained?.transport.reusable ||
      retained.binding !== binding ||
      retained.nativeId !== storedConversationId ||
      turn.freshConversation)
  ) {
    await closeAgyConversation(key);
    retained = undefined;
  }
  assertCurrent();

  const reused = Boolean(retained);
  const resumed = Boolean(storedConversationId);
  const contextFingerprint = fingerprintSystemContext(turn.messages);
  const includeSystem =
    !resumed ||
    (persistent && !reused) ||
    sentSystemContextByConversation.get(key) !== contextFingerprint;
  const { context, question } = splitAgyPrompt({
    messages: turn.messages,
    resumed,
    includeSystem,
  });
  const inlinePrompt = context
    ? `${context}\n\n<question>\n${question}\n</question>`
    : question;

  let scopedMcp: ReturnType<typeof registerScopedZoteroMcpScope> | undefined;
  let workspace = retained?.workspace;
  let contextFile: AgyContextFile | null = null;
  let stopObservingMcp: (() => void) | undefined;
  const runId = createJournalId("agy");
  const execution = turn.executionRequest;
  const clearMcp = () => scopedMcp?.clear();
  const accumulator = new AgyTextAccumulator();
  let initializedAt: number | undefined;
  let firstTextAt: number | undefined;
  let launchedAt: number | undefined;
  let dispatchedAt: number | undefined;
  let closeReason = "complete";
  let rememberedId = storedConversationId;
  let rememberTask: Promise<void> | undefined;
  const remember = (id: string) => {
    if (!id || rememberedId === id) return;
    rememberedId = id;
    if (retained) retained.nativeId = id;
    rememberTask = (
      overrides.rememberConversationId
        ? deps.rememberConversationId(key, id)
        : rememberConversationId(key, id, expected)
    ).catch(() => {
      appLogger.warn("Antigravity: could not save native conversation ID");
    });
  };

  try {
    if (deps.registerMcpScope && deps.prepareWorkspace && mcpServerUrl) {
      scopedMcp = deps.registerMcpScope(
        {
          runtimeAuthority: "antigravity",
          conversationKey: key,
          profileSignature: expected?.profile,
          instanceID: expected?.instanceID,
          runId,
          libraryID:
            summary?.libraryID ?? execution?.libraryID ?? turn.libraryID,
          kind: summary?.kind ?? execution?.conversationKind,
          paperItemID: summary?.paperItemID ?? turn.paperItemID,
          activeItemId: execution?.activeItemId ?? turn.activeItemId,
          activeNoteId: execution?.activeNoteContext?.noteId,
          conversationGeneration: generation,
          executionContext: execution?.executionContext,
          userText: execution?.userText,
          turnPaperScope: execution?.turnPaperScope ?? turn.turnPaperScope,
          attachedConversationScope:
            execution?.attachedConversationScope ??
            turn.attachedConversationScope,
          requestInteraction:
            settings.permissionMode === "default"
              ? panel.onHostInteraction
              : undefined,
        },
        retained ? { token: retained.token } : undefined,
      );
      if (retained) retained.clearScope = clearMcp;
      turn.signal?.addEventListener("abort", clearMcp, { once: true });
      assertCurrent();
      workspace ??=
        (await deps.prepareWorkspace({
          conversationKey: key,
          scopeToken: scopedMcp.token,
          mcpServerUrl,
        })) ?? undefined;
    }
    let prompt = inlinePrompt;
    if (inlinePrompt.length > AGY_INLINE_PROMPT_LIMIT) {
      const fileText =
        question.length > AGY_INLINE_PROMPT_LIMIT / 2 ? inlinePrompt : context;
      contextFile = await deps.writeContextFile(fileText, workspace);
      prompt = contextFile
        ? buildAgyFileContextPrompt({
            question:
              fileText === context
                ? question
                : "The question is at the end of the file below.",
            contextPath: contextFile.path,
            contextChars: fileText.length,
          })
        : `<question>\n${question}\n</question>\n\n${context}`;
    }
    assertCurrent();

    const addDirs: string[] = [];
    if (contextFile && !workspace) addDirs.push(contextFile.dir);
    if (workspace && settings.cwd && settings.cwd !== workspace.dir)
      addDirs.push(settings.cwd);
    const options: AgyTurnOptions = {
      binaryPath: settings.binaryPath,
      prompt,
      ...(addDirs.length ? { addDirs } : {}),
      model,
      effort: settings.effort === "auto" ? undefined : settings.effort,
      mode: settings.permissionMode === "plan" ? "plan" : undefined,
      settingsPath: workspace?.settingsPath,
      conversationId: storedConversationId || undefined,
      cwd: workspace?.dir ?? settings.cwd,
      signal: turn.signal,
      onEvent(event) {
        if (event.kind === "init") {
          initializedAt = Date.now();
          remember(event.conversationId);
        }
        if (event.kind === "result") {
          if (event.response.trim()) firstTextAt ??= Date.now();
          clearMcp();
        }
        if (!panel.isLive()) return;
        if (event.kind === "text") {
          const delta = accumulator.push(
            event.stepIndex,
            event.delta,
            event.state,
          );
          if (delta) {
            firstTextAt ??= Date.now();
            panel.onDelta(delta);
          }
        } else if (event.kind === "tool") {
          const finished = isFinishedStepState(event.state);
          if (!finished)
            panel.onStatus(formatToolStatus(event.toolName, event.summary));
          panel.onActivity?.({
            stepIndex: event.stepIndex,
            toolName: event.toolName,
            summary: event.summary,
            phase: finished ? "completed" : "started",
            failed:
              finished && !/^(DONE|COMPLETED?|SUCCESS)$/i.test(event.state),
          });
        }
      },
    };
    stopObservingMcp = addZoteroMcpToolActivityObserver((event) => {
      if (event.runId === runId && panel.isLive()) panel.onMcpActivity?.(event);
    });
    panel.onStatus("Antigravity is thinking");
    if (
      persistent &&
      !retained &&
      workspace &&
      scopedMcp &&
      summary?.instanceID
    ) {
      launchedAt = Date.now();
      const sessionWorkspace = workspace;
      const token = scopedMcp.token;
      await trackAgyStart(async () => {
        let opened: RetainedAgySession | undefined;
        const transport = await openAgySession(options, launch, () => {
          opened?.clearScope?.();
          if (opened && !activeAgyTurns.has(key))
            void closeAgyConversation(key, false, opened);
        });
        opened = retained = {
          binding,
          nativeId: storedConversationId,
          token,
          workspace: sessionWorkspace,
          transport,
          clearScope: clearMcp,
        };
        agySessions.set(key, opened);
        if (agySessionsStopping())
          await closeAgyConversation(key, true, opened);
        assertCurrent();
      });
    }
    dispatchedAt = Date.now();
    const result = await (retained
      ? retained.transport.send(options)
      : deps.runTurn(options));
    remember(result.conversationId);
    await rememberTask;
    assertCurrent();
    if (retained?.transport.reusable || !persistent) {
      sentSystemContextByConversation.set(key, contextFingerprint);
    }
    const usage = toUsageStats(result.usage);
    if (usage && panel.isLive()) panel.onUsage?.(usage);

    let text = result.response.trim() ? result.response : accumulator.text();
    if (result.deniedActions.length) {
      text +=
        "\n\n> Antigravity was not allowed to: " +
        result.deniedActions.join("; ") +
        ". Change the Antigravity permission mode in settings to allow it.";
    }
    return { text, completion: { status: "complete" } };
  } catch (error) {
    closeReason = turn.signal?.aborted ? "cancelled" : "failed";
    clearMcp();
    if (retained) await closeAgyConversation(key, true, retained);
    await rememberTask;
    throw error;
  } finally {
    clearMcp();
    stopObservingMcp?.();
    turn.signal?.removeEventListener("abort", clearMcp);
    if (retained) {
      retained.clearScope = undefined;
      if (!retained.transport.reusable) {
        if (closeReason === "complete") closeReason = "transport closed";
        await closeAgyConversation(key, false, retained);
      }
    } else {
      if (workspace && deps.removeWorkspace)
        await deps.removeWorkspace(workspace);
      if (contextFile && !workspace) await deps.removeContextFile(contextFile);
    }
    if (persistent)
      appLogger.debug("Antigravity timing", {
        reused,
        outcome: closeReason,
        contextPreparationMs: readyAt - timingStart,
        launchMs:
          launchedAt !== undefined && dispatchedAt !== undefined
            ? dispatchedAt - launchedAt
            : undefined,
        dispatchMs:
          dispatchedAt !== undefined ? dispatchedAt - timingStart : undefined,
        initMs:
          initializedAt !== undefined ? initializedAt - timingStart : undefined,
        firstTextMs:
          firstTextAt !== undefined ? firstTextAt - timingStart : undefined,
        elapsedMs: Date.now() - timingStart,
      });
  }
}
