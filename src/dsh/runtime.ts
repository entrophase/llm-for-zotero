import type {
  ChatMessage,
  ModelTurnOutcome,
  ReasoningConfig,
  UsageStats,
} from "../shared/llm";
import type {
  AgentConfirmationResolution,
  AgentPendingAction,
  AgentRuntimeRequest,
} from "../agent/types";
import {
  addZoteroMcpToolActivityObserver,
  getScopedZoteroMcpDiscoveredTools,
  getZoteroMcpServerUrl,
  registerScopedZoteroMcpScope,
  type ZoteroMcpToolActivityEvent,
} from "../agent/mcp/server";
import { createJournalId } from "../agent/store/changeJournal";
import { loadLatestDocumentForRun } from "../agent/documents/store";
import { getUserSkillsRuntimeRootDir } from "../agent/skills/userSkills";
import { ensureDir } from "../utils/geckoFs";
import { createAbortController } from "../utils/apiHelpers";
import {
  getConversationWriteGeneration,
  isConversationWriteGenerationCurrent,
  withConversationWriteLock,
} from "../shared/conversationWriteFence";
import {
  getDshConversationSummary,
  upsertDshConversationSummary,
} from "./store";
import { getDshEffortPref, getDshRuntimeModelPref } from "./prefs";
import {
  getDshProcess,
  joinDshPath,
  resolveDshLaunch,
  type DshProcess,
} from "./process";
import {
  AcpError,
  configChoices,
  type AcpConfigOption,
  type AcpObject,
} from "./protocol";
import { toDshModelPref, updateDshConfigOptions } from "./modelCatalog";
import { activeDshTurns as running, cancelDshConversation } from "./lifecycle";
export { cancelDshConversation } from "./lifecycle";

export type DshActivity = {
  stepIndex: number;
  toolName: string;
  summary?: string;
  phase: "started" | "completed";
  failed: boolean;
};
export type DshPanelTurn = {
  conversationKey: number;
  runId?: string;
  sourceMessageTimestamp?: number;
  messages: ChatMessage[];
  model?: string;
  reasoning?: ReasoningConfig | string;
  attachedPastChatText?: string;
  signal?: AbortSignal;
  freshConversation?: boolean;
  executionRequest?: AgentRuntimeRequest;
};
export type DshPanelCallbacks = {
  isLive: () => boolean;
  onDelta: (delta: string) => void;
  onStatus: (text: string) => void;
  onUsage?: (usage: UsageStats) => void;
  onDocument?: (documentId: string) => void;
  onContextUsage?: (used: number, size: number) => void;
  onActivity?: (activity: DshActivity) => void;
  onMcpActivity?: (event: ZoteroMcpToolActivityEvent) => void;
  onHostInteraction?: (
    action: AgentPendingAction,
  ) => Promise<AgentConfirmationResolution>;
};

export const forgetDshSentContext = cancelDshConversation;

function abortError(): Error {
  const error = new Error(
    "DSH turn stopped. Continue explicitly to avoid repeating an operation.",
  );
  error.name = "AbortError";
  return error;
}

export function waitForDshOrAbort<T>(
  task: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    void task.catch(() => {});
    return Promise.reject(abortError());
  }
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError());
    signal.addEventListener("abort", abort, { once: true });
    void task
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

export function buildDshPrompt(
  messages: ChatMessage[],
  resumed: boolean,
  imageSupported: boolean,
  pastChat = "",
): AcpObject[] {
  const lastUser = messages.map((m) => m.role).lastIndexOf("user");
  const selected = messages.filter(
    (m, i) => m.role === "system" || !resumed || i === lastUser,
  );
  const text: string[] = [];
  const images: AcpObject[] = [];
  for (const message of selected) {
    const parts =
      typeof message.content === "string"
        ? [{ type: "text" as const, text: message.content }]
        : message.content;
    const contents: string[] = [];
    for (const part of parts) {
      if (part.type === "text") contents.push(part.text);
      else if (part.type === "image_url") {
        if (!imageSupported)
          throw new AcpError(
            "This DSH version does not accept images through ACP. Remove the image and use Zotero paper tools for the PDF.",
          );
        const match = /^data:([^;,]+);base64,(.+)$/s.exec(part.image_url.url);
        if (!match)
          throw new AcpError(
            "DSH image input requires an attached local image.",
          );
        images.push({ type: "image", mimeType: match[1], data: match[2] });
      }
    }
    text.push(`<${message.role}>\n${contents.join("\n")}\n</${message.role}>`);
  }
  if (pastChat)
    text.push(`<attached_past_chat>\n${pastChat}\n</attached_past_chat>`);
  return [{ type: "text", text: text.join("\n\n") }, ...images];
}

export async function answerDshPermission(
  request: AcpObject,
  panel: DshPanelCallbacks,
  signal: AbortSignal,
): Promise<AcpObject> {
  const cancelled = { outcome: { outcome: "cancelled" } };
  if (signal.aborted || !panel.isLive() || !panel.onHostInteraction)
    return cancelled;
  const allow = request.options?.find(
    (o: AcpObject) => o.kind === "allow_once",
  );
  const reject = request.options?.find(
    (o: AcpObject) => o.kind === "reject_once",
  );
  if (!allow || !reject) return cancelled;
  let remove = () => {};
  const decision = await Promise.race([
    panel.onHostInteraction({
      toolName: "dsh_permission",
      title: `DSH: ${request.toolCall?.title || "Tool permission"}`,
      description:
        "DSH requests permission for this operation. This approval applies once.",
      mode: "approval",
      confirmLabel: "Allow once",
      cancelLabel: "Deny",
      fields: [
        {
          id: "operation",
          type: "code_preview",
          label: "Operation",
          language: "json",
          value: JSON.stringify(request.toolCall || {}, null, 2),
        },
      ],
    }),
    new Promise<AgentConfirmationResolution>((resolve) => {
      const abort = () => resolve({ approved: false });
      signal.addEventListener("abort", abort, { once: true });
      remove = () => signal.removeEventListener("abort", abort);
    }),
  ]).finally(() => remove());
  if (signal.aborted || !panel.isLive()) return cancelled;
  return {
    outcome: {
      outcome: "selected",
      optionId: decision.approved ? allow.optionId : reject.optionId,
    },
  };
}

export async function applyDshOptions(
  process: DshProcess,
  sessionId: string,
  initial: AcpConfigOption[],
  model: string,
  effort: string,
): Promise<AcpConfigOption[]> {
  let options = initial;
  for (const [category, value] of [
    ["model", model],
    ["thought_level", effort === "auto" ? "" : effort],
  ]) {
    if (!value) continue;
    const option = options.find(
      (o) => o.category === category && o.type === "select",
    );
    if (!option || !configChoices(option).some((o) => o.value === value)) {
      throw new AcpError(
        `DSH no longer offers ${category} option “${value}”. Refresh the DSH model menu and select an available option.`,
      );
    }
    const result = await process.rpc.request("session/set_config_option", {
      sessionId,
      configId: option.id,
      value,
    });
    options = result.configOptions || options;
  }
  updateDshConfigOptions(options);
  return options;
}

const DEFAULT_DEPS = {
  getSummary: getDshConversationSummary,
  saveSummary: upsertDshConversationSummary,
  resolveLaunch: resolveDshLaunch,
  getProcess: getDshProcess,
  ensureDir,
  rootDir: getUserSkillsRuntimeRootDir,
  loadDocument: loadLatestDocumentForRun,
  registerScope: registerScopedZoteroMcpScope,
  discoveredTools: getScopedZoteroMcpDiscoveredTools,
  mcpUrl: getZoteroMcpServerUrl,
  observeMcp: addZoteroMcpToolActivityObserver,
};
export type DshTurnDeps = typeof DEFAULT_DEPS;

/** One turn owns its credential and active session; the process can serve siblings. */
export async function runDshPanelTurn(
  turn: DshPanelTurn,
  panel: DshPanelCallbacks,
  overrides: Partial<DshTurnDeps> = {},
): Promise<ModelTurnOutcome> {
  const deps = { ...DEFAULT_DEPS, ...overrides };
  const key = turn.conversationKey;
  if (running.has(key))
    throw new AcpError("This DSH conversation is already running.");
  if (turn.freshConversation)
    throw new AcpError(
      "DSH ACP cannot rewrite earlier turns. Create a new conversation instead.",
    );
  if (!turn.executionRequest)
    throw new AcpError(
      "Zotero context is unavailable. Reopen this conversation and retry.",
    );
  const controller = createAbortController();
  const execution = turn.executionRequest;
  const generation = getConversationWriteGeneration(key);
  const runId = turn.runId || createJournalId("dsh");
  let process: DshProcess | undefined;
  let sessionId = "";
  let scope: ReturnType<typeof registerScopedZoteroMcpScope> | undefined;
  let stopObserving = () => {};
  let unsubscribe = () => {};
  let stopCloseObserver = () => {};
  let promptTask: Promise<AcpObject> | undefined;
  let text = "";
  let promptStarted = false;
  let processInterrupted = false;
  let submittedDocument = false;
  const pendingMcp = new Map<string, ZoteroMcpToolActivityEvent>();
  const toolStates = new Map<
    string,
    { index: number; title: string; zotero: boolean; call: AcpObject }
  >();
  const live = () =>
    !controller.signal.aborted &&
    panel.isLive() &&
    isConversationWriteGenerationCurrent(key, generation);
  const cancel = () => {
    scope?.clear(); // Revoke before notifying DSH or resolving any approval.
    controller.abort();
    if (sessionId && process && !process.rpc.closed) {
      process.rpc.notify("session/cancel", { sessionId });
    }
  };
  running.set(key, cancel);
  turn.signal?.addEventListener("abort", cancel, { once: true });
  const assertLive = () => {
    if (!live()) {
      cancel();
      throw abortError();
    }
  };
  try {
    if (turn.signal?.aborted) cancel();
    assertLive();
    const summary = await deps.getSummary(key);
    if (!summary)
      throw new AcpError(
        "DSH conversation was removed. Create a new conversation.",
      );
    const launch = await deps.resolveLaunch();
    const cwd =
      summary.cwd ||
      joinDshPath(
        deps.rootDir(),
        "dsh",
        `${key}-${summary.instanceID || "session"}`,
      );
    const binding = JSON.stringify({
      home: launch.home,
      command: launch.command,
      script: launch.args[0],
      cwd,
      instanceID: summary.instanceID,
      generation: Number(summary.runtimeGeneration || 0),
    });
    if (summary.providerSessionId && summary.runtimeBinding !== binding) {
      throw new AcpError(
        "DSH session cannot be resumed because its Home, executable, workspace or conversation identity changed. Restore the original settings or choose New conversation.",
      );
    }
    if (!(await deps.ensureDir(cwd)))
      throw new AcpError("Cannot create the DSH conversation workspace.");
    panel.onStatus("Connecting to DSH ACP…");
    process = await waitForDshOrAbort(
      deps.getProcess(launch),
      controller.signal,
    );
    assertLive();
    stopCloseObserver = process.rpc.onClose(() => {
      processInterrupted = !controller.signal.aborted;
      scope?.clear();
      controller.abort();
    });
    scope = deps.registerScope({
      runtimeAuthority: "dsh",
      runId,
      signal: controller.signal,
      sourceMessageTimestamp: turn.sourceMessageTimestamp,
      conversationKey: key,
      instanceID: summary.instanceID,
      conversationGeneration: generation,
      libraryID: execution.libraryID,
      kind: execution.conversationKind,
      activeItemId: execution.activeItemId,
      activeNoteId: execution.activeNoteContext?.noteId,
      executionContext: execution.executionContext,
      userText: execution.userText,
      turnPaperScope: execution.turnPaperScope,
      attachedConversationScope: execution.attachedConversationScope,
      requestInteraction: async (action) => {
        assertLive();
        const result = (await panel.onHostInteraction?.(action)) || {
          approved: false,
        };
        assertLive();
        return result;
      },
    });
    const mcpServers = [
      {
        type: "http",
        name: "llm_for_zotero",
        url: deps.mcpUrl(),
        headers: [
          { name: "Authorization", value: `Bearer ${scope.token}` },
          { name: "X-LLM-For-Zotero-Scope", value: scope.token },
        ],
      },
    ];
    const openingProcess = process;
    const opening = process.rpc
      .request(
        summary.providerSessionId ? "session/resume" : "session/new",
        {
          ...(summary.providerSessionId
            ? { sessionId: summary.providerSessionId }
            : {}),
          cwd,
          mcpServers,
        },
        180_000,
      )
      .then(async (result) => {
        if (!live()) {
          const lateId = result.sessionId || summary.providerSessionId;
          if (lateId) {
            try {
              await openingProcess.rpc.request(
                "session/close",
                { sessionId: lateId },
                10_000,
              );
            } catch {
              openingProcess.rpc.close();
            }
          }
          throw abortError();
        }
        return result;
      })
      .catch((error) => {
        if (String(error).includes("timed out")) openingProcess.rpc.close();
        throw new AcpError(
          `${summary.providerSessionId ? "DSH session restore failed" : "DSH session creation failed"}: ${String(error)}. You can choose New conversation; the previous task has not been resent.`,
        );
      });
    const opened = await waitForDshOrAbort(opening, controller.signal);
    sessionId = opened.sessionId || summary.providerSessionId || "";
    assertLive();
    if (!sessionId) throw new AcpError("DSH returned no session ID.");
    const tools = deps.discoveredTools(scope.token);
    if (!tools.includes("paper_read") || !tools.includes("library_search")) {
      throw new AcpError(
        "DSH connected, but Zotero tool discovery failed. Check that Zotero's local HTTP server is enabled and localhost bypasses your proxy. No model request was sent.",
      );
    }
    const options = await applyDshOptions(
      process,
      sessionId,
      opened.configOptions || [],
      toDshModelPref(turn.model || getDshRuntimeModelPref()),
      getDshEffortPref(),
    );
    assertLive();
    // Save before prompting: a network interruption must never lose an already
    // created session and cause an automatic replay into a replacement.
    await withConversationWriteLock(key, async () => {
      assertLive();
      const current = await deps.getSummary(key);
      if (current?.instanceID !== summary.instanceID) throw abortError();
      await deps.saveSummary({
        ...summary,
        providerSessionId: sessionId,
        cwd,
        runtimeBinding: binding,
        updatedAt: Date.now(),
        model: options.find((o) => o.category === "model")?.currentValue,
        effort: options.find((o) => o.category === "thought_level")
          ?.currentValue,
      });
    });
    stopObserving = deps.observeMcp((event) => {
      // Results already committed before cancellation (including receipts) are
      // retained. New writes are fenced by the revoked credential.
      if (
        event.runId === runId &&
        event.conversationKey === key &&
        event.conversationGeneration === generation &&
        (panel.isLive() ||
          (controller.signal.aborted && event.phase === "completed")) &&
        isConversationWriteGenerationCurrent(key, generation)
      ) {
        const eventKey = event.requestId || event.toolName;
        if (event.phase === "started") pendingMcp.set(eventKey, event);
        else if (event.phase === "completed") pendingMcp.delete(eventKey);
        if (
          event.phase === "completed" &&
          event.ok &&
          (event.toolName === "submit_document" || event.publishedDocumentId)
        )
          submittedDocument = true;
        panel.onMcpActivity?.(event);
      }
    });
    unsubscribe = process.rpc.subscribe(sessionId, {
      permission: (request) =>
        answerDshPermission(
          {
            ...request,
            toolCall: {
              ...toolStates.get(String(request.toolCall?.toolCallId || ""))
                ?.call,
              ...request.toolCall,
            },
          },
          { ...panel, isLive: live },
          controller.signal,
        ),
      update: (update) => {
        if (!live()) return;
        if (
          update.sessionUpdate === "agent_message_chunk" &&
          update.content?.type === "text"
        ) {
          text += update.content.text;
          panel.onDelta(update.content.text);
        } else if (update.sessionUpdate === "config_option_update") {
          updateDshConfigOptions(update.configOptions || []);
        } else if (
          update.sessionUpdate === "tool_call" ||
          update.sessionUpdate === "tool_call_update"
        ) {
          const id = String(update.toolCallId || "");
          const state = toolStates.get(id) || {
            index: toolStates.size,
            title: String(update.title || "DSH tool"),
            zotero: /llm_for_zotero/.test(String(update.title || "")),
            call: {},
          };
          state.title = update.title || state.title;
          state.call = { ...state.call, ...update };
          toolStates.set(id, state);
          const done =
            update.status === "completed" || update.status === "failed";
          if (!done) panel.onStatus(`DSH: ${state.title}`);
          // Zotero's activity carries richer sources and receipts; it owns that row.
          if (!state.zotero)
            panel.onActivity?.({
              stepIndex: state.index,
              toolName: state.title,
              summary: update.title || state.title,
              phase: done ? "completed" : "started",
              failed: update.status === "failed",
            });
        } else if (
          update.sessionUpdate === "usage_update" &&
          Number.isFinite(update.used) &&
          Number.isFinite(update.size) &&
          update.used >= 0 &&
          update.size > 0
        ) {
          // ACP currently reports context occupancy, not billable input/output.
          panel.onContextUsage?.(update.used, update.size);
          panel.onStatus(`DSH context: ${update.used} / ${update.size} tokens`);
        }
      },
    });
    const prompt = buildDshPrompt(
      turn.messages,
      Boolean(summary.providerSessionId),
      Boolean(process.capabilities.promptCapabilities?.image),
      turn.attachedPastChatText,
    );
    assertLive();
    promptStarted = true;
    panel.onStatus("DSH is working…");
    promptTask = process.rpc.request(
      "session/prompt",
      { sessionId, prompt },
      0,
    );
    const result = await waitForDshOrAbort(promptTask, controller.signal);
    assertLive();
    if (result.stopReason === "cancelled") throw abortError();
    if (submittedDocument) {
      const document = await deps.loadDocument(runId);
      assertLive();
      if (document) panel.onDocument?.(document.documentId);
    }
    return {
      text,
      completion:
        result.stopReason === "max_tokens"
          ? {
              status: "incomplete",
              reason: "output_limit",
              providerReason: result.stopReason,
            }
          : result.stopReason === "refusal"
            ? { status: "blocked", reason: "refusal" }
            : { status: "complete" },
    };
  } catch (error) {
    if (processInterrupted)
      throw new AcpError(
        "DSH process exited and this conversation was interrupted. Review recorded operations, then send a continuation when ready. The task was not resent.",
      );
    if (promptStarted && !controller.signal.aborted)
      panel.onStatus(
        "DSH interrupted. Recorded operations remain in task progress; check uncertain results before continuing.",
      );
    throw error;
  } finally {
    scope?.clear();
    controller.abort();
    turn.signal?.removeEventListener("abort", cancel);
    unsubscribe();
    stopCloseObserver();
    if (sessionId && process && !process.rpc.closed) {
      if (controller.signal.aborted && promptTask) {
        let grace: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          promptTask.catch(() => {}),
          new Promise<void>((resolve) => {
            grace = setTimeout(resolve, 5_000);
          }),
        ]);
        clearTimeout(grace);
      }
      try {
        await process.rpc.request("session/close", { sessionId }, 10_000);
      } catch {
        process.rpc.close(
          new AcpError("DSH session close failed; its process was recycled."),
        );
      }
    }
    stopObserving();
    // A stopped connection cannot establish whether an outstanding operation
    // committed. Retain recorded receipts and label missing outcomes explicitly.
    if (isConversationWriteGenerationCurrent(key, generation)) {
      const uncertain =
        "Operation result not confirmed — verify before retrying (结果待核对).";
      for (const event of pendingMcp.values())
        panel.onMcpActivity?.({ ...event, error: uncertain });
      for (const state of toolStates.values()) {
        if (
          !state.zotero &&
          state.call.status !== "completed" &&
          state.call.status !== "failed"
        )
          panel.onActivity?.({
            stepIndex: state.index,
            toolName: state.title,
            summary: uncertain,
            phase: "started",
            failed: false,
          });
      }
    }
    running.delete(key);
  }
}
