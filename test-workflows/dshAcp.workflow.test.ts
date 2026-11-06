import "./hostSurfaceBootstrap";
import { assert } from "chai";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
  WorkflowTestSeededHistoryConversation,
} from "../src/modules/contextPanel/workflowTestTypes";
import { isConversationKeyForKind } from "../src/shared/conversationKeySpace";
import {
  approveCardsUntil,
  panelElement,
} from "../test-live/runtimes/runtimeLiveShared";

describe("workflow: DSH independent conversations", function () {
  this.timeout(180000);
  let api: WorkflowTestApi;
  const fixtures: WorkflowTestFixture[] = [];
  const seeded: WorkflowTestSeededHistoryConversation[] = [];
  const saved = new Map<string, unknown>();
  beforeEach(async function () {
    api = (Zotero as any).LLMForZotero.api.workflowTest;
    await api.reset();
    for (const [key, value] of Object.entries({
      enableAgentMode: true,
      enableDshMode: true,
      conversationSystem: "upstream",
    })) {
      const full = `extensions.zotero.llmforzotero.${key}`;
      saved.set(full, Zotero.Prefs.get(full, true));
      Zotero.Prefs.set(full, value, true);
    }
  });
  afterEach(async function () {
    await api.closeStandalone();
    while (seeded.length)
      await api.deleteSeededHistoryConversation(seeded.pop()!);
    while (fixtures.length) await api.cleanupFixture(fixtures.pop()!);
    await api.reset();
    for (const [key, value] of saved) {
      if (value === undefined) Zotero.Prefs.clear(key, true);
      else Zotero.Prefs.set(key, value as string | boolean | number, true);
    }
    saved.clear();
  });
  async function paper(title: string) {
    const f = await api.createPaperWithPdfFixture({
      title,
      pdfTitle: `${title} PDF`,
      pages: [
        "This temporary research fixture reports a stable oscillation in a simulated mechanical system under a constant load. The result applies only to the selected parameters and initial conditions, and does not establish global stability.",
      ],
    });
    fixtures.push(f);
    return f;
  }
  async function seed(
    kind: "global" | "paper",
    text: string,
    paperItemId?: number,
  ) {
    const s = await api.seedHistoryConversation({
      system: "dsh",
      kind,
      paperItemId,
      userText: text,
      assistantText: `DSH answer: ${text}`,
    });
    seeded.push(s);
    return s;
  }
  it("switches runtime, opens, searches and renames DSH library history", async function () {
    const f = await paper("DSH library history fixture");
    const { panelId } = await api.renderPanelForItem(f.parentItemId);
    if ((await api.getDiagnostics(panelId)).conversationKind !== "global")
      await api.togglePanelConversationMode(panelId);
    const switched = await api.pickPanelRuntime(panelId, "dsh");
    assert.equal(switched.conversationSystem, "dsh", JSON.stringify(switched));
    assert.isTrue(
      isConversationKeyForKind("dsh", "global", switched.conversationKey!),
    );
    const chat = await seed("global", `dshhistory${Date.now()}`);
    const rows = await api.listPanelHistory(panelId, { reopen: true });
    assert.include(
      rows.map((r) => r.conversationKey),
      chat.conversationKey,
    );
    const opened = await api.clickPanelHistoryRow(
      panelId,
      chat.conversationKey,
    );
    assert.equal(opened.conversationSystem, "dsh");
    assert.equal(opened.runtimeBadge?.label, "DSH");
    const renamed = await api.renamePanelHistoryConversation(
      panelId,
      chat.conversationKey,
      "DSH renamed fixture",
    );
    assert.equal(renamed.dsh, "DSH renamed fixture");
    assert.isNull(renamed.codex);
    const result = await api.searchAndOpenPanelHistory(
      panelId,
      "DSH renamed fixture",
      chat.conversationKey,
    );
    assert.isTrue(result.opened, JSON.stringify(result));
    await api.openPanelRuntimeMenu(panelId);
    const buttons = Array.from(
      panelElement(panelId).querySelectorAll<HTMLButtonElement>(
        "#llm-runtime-menu button",
      ),
    ) as HTMLButtonElement[];
    const clear = buttons.find(
      (button) => button.textContent === "Clear DSH conversation",
    );
    assert.isOk(clear, "DSH exposes clear in its runtime menu");
    clear!.click();
    let generation = "0";
    for (let i = 0; i < 100 && generation === "0"; i++) {
      await Zotero.Promise.delay(30);
      generation = String(
        await Zotero.DB.valueQueryAsync(
          "SELECT runtime_generation FROM llm_for_zotero_dsh_conversations WHERE conversation_key = ?",
          [chat.conversationKey],
        ),
      );
    }
    assert.equal(generation, "1");
    assert.equal(
      Number(
        await Zotero.DB.valueQueryAsync(
          "SELECT COUNT(*) FROM llm_for_zotero_dsh_messages WHERE conversation_key = ?",
          [chat.conversationKey],
        ),
      ),
      0,
    );
  });
  it("opens a paper history in its real paper scope and restores it in the standalone window", async function () {
    const a = await paper("DSH scope paper A"),
      b = await paper("DSH scope paper B");
    const word = `dshpaper${Date.now()}`;
    const chat = await seed("paper", word, b.parentItemId);
    const { panelId } = await api.renderPanelForItem(a.parentItemId);
    const found = await api.searchAndOpenPanelHistory(
      panelId,
      word,
      chat.conversationKey,
    );
    assert.isTrue(found.opened, JSON.stringify(found));
    const panelB = await api.renderPanelForItem(b.parentItemId);
    const opened = await api.getDiagnostics(panelB.panelId);
    assert.equal(
      opened.conversationKey,
      chat.conversationKey,
      JSON.stringify(opened),
    );
    assert.equal(opened.conversationSystem, "dsh");
    await api.openStandaloneForItem(b.parentItemId);
    const rows = await api.listStandaloneSidebarHistory();
    assert.include(
      rows.map((r) => r.conversationKey),
      chat.conversationKey,
    );
    const standalone = await api.clickStandaloneSidebarHistoryRow(
      chat.conversationKey,
    );
    assert.equal(
      standalone.conversationSystem,
      "dsh",
      JSON.stringify(standalone),
    );
    assert.equal(standalone.conversationKey, chat.conversationKey);
  });
  it("opt-in: reads a temporary paper through real DSH and resumes the same session", async function () {
    const env = (Components.classes as any)[
      "@mozilla.org/process/environment;1"
    ].getService(Components.interfaces.nsIEnvironment);
    if (env.get("LLM_FOR_ZOTERO_DSH_LIVE") !== "1") this.skip();
    this.timeout(480000);
    const f = await paper("DSH live temporary paper");
    const { panelId } = await api.renderPanelForItem(f.parentItemId);
    if ((await api.getDiagnostics(panelId)).conversationKind !== "paper")
      await api.togglePanelConversationMode(panelId);
    const selected = await api.pickPanelRuntime(panelId, "dsh");
    const firstStarted = Date.now();
    const first = await api.sendLiveChatTurn(
      panelId,
      "仅处理当前论文。请调用 paper_read 读取它，用一句话概括并给出原文引用。记住本轮口令 DSH_ROUND_TRIP_847。不执行任何写入。",
      210000,
    );
    assert.notMatch(
      first.answerText,
      /(?:Error:|not found|restore failed|creation failed|tool discovery failed|Authentication|API key)/i,
      first.answerText,
    );
    assert.isTrue(first.assistantFinalized, JSON.stringify(first));
    const firstMs = Date.now() - firstStarted;
    const stored = (await Zotero.DB.queryAsync(
      "SELECT agent_run_id, quote_citations_json FROM llm_for_zotero_dsh_messages WHERE conversation_key = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1",
      [selected.conversationKey],
    )) as Array<{ agent_run_id: string; quote_citations_json: string }>;
    const quotes = JSON.parse(stored[0].quote_citations_json || "[]");
    assert.isNotEmpty(quotes, "MCP paper reads must return grounded citations");
    assert.isTrue(
      quotes.some((q: any) => q.contextItemId === f.pdfAttachmentId),
      "citations belong to the real fixture PDF",
    );
    const citationButton =
      panelElement(panelId).querySelector<HTMLElement>(".llm-citation-icon");
    assert.isOk(citationButton, "answer exposes an original-source link");
    const navigation = await api.observeCitationNavigationFocus(
      citationButton!,
    );
    assert.isTrue(navigation.finished, JSON.stringify(navigation));
    const row = (await Zotero.DB.rowQueryAsync(
      "SELECT provider_session_id FROM llm_for_zotero_dsh_conversations WHERE conversation_key = ?",
      [selected.conversationKey],
    )) as { provider_session_id: string };
    assert.isString(row.provider_session_id);
    assert.isNotEmpty(row.provider_session_id);
    const resumeStarted = Date.now();
    await api.setMountedPanelSelectedText(
      panelElement(panelId),
      "SELECTED_SCOPE_519: The result does not establish global stability.",
    );
    const next = await api.sendLiveChatTurn(
      panelId,
      "上一轮我让你记住的口令是什么？当前附加选区以什么英文标识开头？只回复这两个标识。",
      210000,
    );
    assert.include(next.answerText, "DSH_ROUND_TRIP_847");
    assert.include(next.answerText, "SELECTED_SCOPE_519");
    await api.setMountedPanelSelectedText(panelElement(panelId), null);
    const restored = (await Zotero.DB.rowQueryAsync(
      "SELECT provider_session_id FROM llm_for_zotero_dsh_conversations WHERE conversation_key = ?",
      [selected.conversationKey],
    )) as { provider_session_id: string };
    assert.equal(restored.provider_session_id, row.provider_session_id);
    const resumedMs = Date.now() - resumeStarted;
    const compared = await paper("DSH comparison temporary paper B");
    await api.setTaskProgressComposerContexts({
      panelId,
      paperContexts: [
        {
          itemId: compared.parentItemId,
          contextItemId: compared.pdfAttachmentId,
          title: "DSH comparison temporary paper B",
        },
      ],
    });
    const comparison = await api.sendLiveChatTurn(
      panelId,
      "请调用 paper_read 读取当前论文以及附加的 comparison temporary paper B，简要比较两篇的结论范围，并引用各自原文；不要写入。",
      210000,
    );
    assert.isTrue(comparison.assistantFinalized);
    const comparisonRows = (await Zotero.DB.queryAsync(
      "SELECT quote_citations_json FROM llm_for_zotero_dsh_messages WHERE conversation_key = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1",
      [selected.conversationKey],
    )) as Array<{ quote_citations_json: string }>;
    const comparisonQuotes = JSON.parse(
      comparisonRows[0].quote_citations_json || "[]",
    );
    assert.includeMembers(
      comparisonQuotes.map((q: any) => q.contextItemId),
      [f.pdfAttachmentId, compared.pdfAttachmentId],
    );
    await api.setTaskProgressComposerContexts({ panelId, paperContexts: [] });
    const approved: Array<{ requestId: string; text: string }> = [];
    const parent = Zotero.Items.get(f.parentItemId);
    const beforeNotes = new Set(parent.getNotes());
    let noteAppeared = false;
    let clickedStop = false;
    const watchWrite = setInterval(() => {
      if (parent.getNotes().some((id: number) => !beforeNotes.has(id))) {
        noteAppeared = true;
        const cancel =
          panelElement(panelId).querySelector<HTMLButtonElement>("#llm-cancel");
        if (cancel && cancel.style.display !== "none" && !cancel.disabled) {
          cancel.click();
          clickedStop = true;
        }
      }
    }, 25);
    try {
      await approveCardsUntil(
        panelId,
        api.sendLiveChatTurn(
          panelId,
          "请仅使用 note_write 在当前论文下新建一条子笔记，标题 DSH_ACCEPTANCE_NOTE，正文为 DSH approval verified。保存后再用一句话说明已保存；不要创建第二条笔记或修改其他内容。",
          210000,
        ),
        approved,
      );
    } finally {
      clearInterval(watchWrite);
    }
    assert.isAtLeast(
      approved.length,
      1,
      "Zotero write required host confirmation",
    );
    assert.isTrue(
      noteAppeared,
      "approved write created a temporary child note",
    );
    assert.isTrue(clickedStop, "stop was available after the confirmed write");
    const afterNotes = parent
      .getNotes()
      .filter((id: number) => !beforeNotes.has(id));
    await Zotero.Promise.delay(500);
    assert.deepEqual(
      parent.getNotes().filter((id: number) => !beforeNotes.has(id)),
      afterNotes,
      "no later writes after stop",
    );
    const record = {
      version: "0.2.2-rc.1",
      firstMs,
      resumedMs,
      citations: quotes.length,
      citationNavigation: navigation.finished,
      selectedTextContext: true,
      comparedPaperSources: 2,
      hostApprovalCards: approved.length,
      noteWrittenBeforeStop: noteAppeared,
      stoppedAfterWrite: clickedStop,
    };
    await Zotero.File.putContentsAsync(
      PathUtils.join(Zotero.DataDirectory.dir, "dsh-acp-acceptance.json"),
      JSON.stringify(record, null, 2),
    );
  });
});
