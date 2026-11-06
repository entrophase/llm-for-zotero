import "./hostSurfaceBootstrap";
import { assert } from "chai";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";
import {
  approveCardsUntil,
  env,
} from "../test-live/runtimes/runtimeLiveShared";

/** Run create, stop ONLY the isolated test Zotero, copy its data, then resume
 * with LLM_FOR_ZOTERO_QA_DATA_SNAPSHOT pointing to that copy. */
describe("workflow: DSH across a real Zotero restart", function () {
  this.timeout(300000);
  it("opt-in: persists or resumes the native session and reviews a native file operation", async function () {
    const phase = env("LLM_FOR_ZOTERO_DSH_RESTART_PHASE");
    if (phase !== "create" && phase !== "resume") this.skip();
    const api = (Zotero as any).LLMForZotero.api
      .workflowTest as WorkflowTestApi;
    await api.reset();
    const previous = new Map<string, unknown>();
    for (const [key, value] of Object.entries({
      enableAgentMode: true,
      enableDshMode: true,
      conversationSystem: "upstream",
    })) {
      const pref = `extensions.zotero.llmforzotero.${key}`;
      previous.set(pref, Zotero.Prefs.get(pref, true));
      Zotero.Prefs.set(pref, value, true);
    }
    const recordPath = PathUtils.join(
      Zotero.DataDirectory.dir,
      "dsh-restart.json",
    );
    let fixture: WorkflowTestFixture | undefined;
    try {
      let record: {
        fixture: WorkflowTestFixture;
        conversationKey: number;
        sessionId: string;
      };
      if (phase === "create") {
        fixture = await api.createPaperWithPdfFixture({
          title: "DSH restart acceptance temporary paper",
          pdfTitle: "DSH restart PDF",
          pages: [
            "This is a temporary fixture for verifying native conversation restoration across a Zotero restart.",
          ],
        });
        const { panelId } = await api.renderPanelForItem(fixture.parentItemId);
        if ((await api.getDiagnostics(panelId)).conversationKind !== "paper")
          await api.togglePanelConversationMode(panelId);
        const selected = await api.pickPanelRuntime(panelId, "dsh");
        const answer = await api.sendLiveChatTurn(
          panelId,
          "请记住重启口令 DSH_RESTART_631，并只回复已记住。不调用工具。",
          210000,
        );
        assert.isTrue(answer.assistantFinalized);
        const sessionId = String(
          await Zotero.DB.valueQueryAsync(
            "SELECT provider_session_id FROM llm_for_zotero_dsh_conversations WHERE conversation_key = ?",
            [selected.conversationKey],
          ),
        );
        assert.isNotEmpty(sessionId);
        record = {
          fixture,
          conversationKey: selected.conversationKey!,
          sessionId,
        };
        await Zotero.File.putContentsAsync(recordPath, JSON.stringify(record));
        fixture = undefined; // Resume phase owns cleanup; preserve the actual database.
      } else {
        record = JSON.parse(
          String(await Zotero.File.getContentsAsync(recordPath)),
        );
        fixture = record.fixture;
        const { panelId } = await api.renderPanelForItem(fixture.parentItemId);
        const opened = await api.clickPanelHistoryRow(
          panelId,
          record.conversationKey,
        );
        assert.equal(opened.conversationSystem, "dsh");
        const answer = await api.sendLiveChatTurn(
          panelId,
          "上一次 Zotero 退出前让你记住的重启口令是什么？只回复口令。",
          210000,
        );
        assert.include(answer.answerText, "DSH_RESTART_631");
        assert.equal(
          String(
            await Zotero.DB.valueQueryAsync(
              "SELECT provider_session_id FROM llm_for_zotero_dsh_conversations WHERE conversation_key = ?",
              [record.conversationKey],
            ),
          ),
          record.sessionId,
        );
        const file = PathUtils.join(
          Zotero.DataDirectory.dir,
          "dsh-native-approval.txt",
        );
        const approved: Array<{ requestId: string; text: string }> = [];
        try {
          await approveCardsUntil(
            panelId,
            api.sendLiveChatTurn(
              panelId,
              `验收 DSH 原生审批：请仅用你的原生 write 工具写入 ${JSON.stringify(file)}，content 为 DSH_NATIVE_APPROVED。请明确传 sandbox_permissions="danger-full-access" 和 justification="Verify one-time host approval"，在审批允许后执行。不使用 Zotero 工具或终端。`,
              210000,
            ),
            approved,
          );
          assert.isAtLeast(
            approved.length,
            1,
            "native ACP request appeared in Zotero confirmation UI",
          );
          assert.include(
            await Zotero.File.getContentsAsync(file),
            "DSH_NATIVE_APPROVED",
          );
          await Zotero.File.putContentsAsync(
            PathUtils.join(
              Zotero.DataDirectory.dir,
              "dsh-restart-acceptance.json",
            ),
            JSON.stringify(
              {
                restoredSameNativeSession: true,
                nativeHostApprovalCards: approved.length,
                nativeFileWritten: true,
              },
              null,
              2,
            ),
          );
        } finally {
          await IOUtils.remove(file, { ignoreAbsent: true });
        }
      }
    } finally {
      if (fixture) await api.cleanupFixture(fixture);
      await api.reset();
      for (const [pref, value] of previous) {
        if (value === undefined) Zotero.Prefs.clear(pref, true);
        else Zotero.Prefs.set(pref, value as string | boolean | number, true);
      }
    }
  });
});
