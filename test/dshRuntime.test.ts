import { assert } from "chai";
import {
  runDshPanelTurn,
  buildDshPrompt,
  answerDshPermission,
  type DshTurnDeps,
} from "../src/dsh/runtime";
import { AcpConnection } from "../src/dsh/protocol";
import { cancelDshConversation } from "../src/dsh/lifecycle";
import { bumpConversationWriteGeneration } from "../src/shared/conversationWriteFence";

const messages = [
  { role: "system" as const, content: "Current paper scope" },
  { role: "user" as const, content: "first" },
  { role: "assistant" as const, content: "answer" },
  { role: "user" as const, content: "second" },
];

function harness() {
  let summary: any = {
    conversationKey: 1e15 + 1,
    conversationID: "dsh-test",
    instanceID: "dsh-instance",
    libraryID: 1,
    kind: "paper",
    paperItemID: 42,
    createdAt: 1,
    updatedAt: 1,
    userTurnCount: 0,
    runtimeGeneration: "0",
  };
  const sent: any[] = [],
    scopes: any[] = [],
    cleared: string[] = [],
    deltas: string[] = [];
  let behavior = (_message: any): boolean => false;
  const rpc = new AcpConnection({
    write: (line) => {
      const m = JSON.parse(line);
      sent.push(m);
      queueMicrotask(() => {
        if (behavior(m)) return;
        if (m.id === undefined) return;
        let result: any = {};
        if (m.method === "session/new")
          result = { sessionId: "session-1", configOptions: [] };
        if (m.method === "session/resume") result = { configOptions: [] };
        if (m.method === "session/prompt") {
          rpc.receive(
            JSON.stringify({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: m.params.sessionId,
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: "Response" },
                },
              },
            }) + "\n",
          );
          result = { stopReason: "end_turn" };
        }
        rpc.receive(
          JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\n",
        );
      });
    },
    kill: () => {},
  });
  const launch = {
    command: "C:/Node Path/node.exe",
    args: ["C:/DSH Path/lib/bin.js", "--profile", "acp"],
    home: "C:/DSH Home",
    identity: "test",
    environment: {},
  };
  const deps: Partial<DshTurnDeps> = {
    getSummary: async () => summary,
    saveSummary: async (value) => {
      summary = { ...summary, ...value };
      return true;
    },
    resolveLaunch: async () => launch,
    getProcess: async () => ({
      rpc,
      launch,
      capabilities: { promptCapabilities: { image: false } },
    }),
    ensureDir: async () => true,
    rootDir: () => "C:/Workspace",
    mcpUrl: () => "http://127.0.0.1:23119/mcp",
    registerScope: (scope) => {
      scopes.push(scope);
      const token = `token-${scopes.length}`;
      return {
        token,
        clear: () => {
          cleared.push(token);
        },
        getState: () => scope,
      };
    },
    discoveredTools: () => ["paper_read", "library_search"],
    observeMcp: () => () => {},
  };
  const panel = {
    isLive: () => true,
    onDelta: (text: string) => deltas.push(text),
    onStatus: () => {},
  };
  const turn = {
    conversationKey: summary.conversationKey,
    messages,
    executionRequest: {
      libraryID: 1,
      conversationKind: "paper",
      activeItemId: 42,
      turnPaperScope: { conversationKind: "paper", papers: [] },
    } as any,
  };
  return {
    rpc,
    deps,
    panel,
    turn,
    sent,
    scopes,
    cleared,
    deltas,
    summary: () => summary,
    setBehavior: (fn: typeof behavior) => {
      behavior = fn;
    },
  };
}

describe("DSH panel lifecycle", function () {
  it("closes active sessions, persists identity, rebinds credentials and resumes without replaying history", async function () {
    const h = harness();
    await runDshPanelTurn(h.turn, h.panel, h.deps);
    assert.equal(h.summary().providerSessionId, "session-1");
    assert.equal(h.scopes[0].runtimeAuthority, "dsh");
    assert.equal(h.scopes[0].activeItemId, 42);
    await runDshPanelTurn(h.turn, h.panel, h.deps);
    assert.equal(h.sent.filter((m) => m.method === "session/close").length, 2);
    assert.equal(h.sent.filter((m) => m.method === "session/new").length, 1);
    const resume = h.sent.find((m) => m.method === "session/resume");
    assert.equal(resume.params.sessionId, "session-1");
    assert.equal(
      resume.params.mcpServers[0].headers[0].value,
      "Bearer token-2",
    );
    const prompts = h.sent.filter((m) => m.method === "session/prompt");
    assert.include(prompts[0].params.prompt[0].text, "first");
    assert.notInclude(prompts[1].params.prompt[0].text, "first");
    assert.deepEqual(h.deltas, ["Response", "Response"]);
    assert.include(h.cleared, "token-1");
    assert.include(h.cleared, "token-2");
    h.rpc.close();
  });
  it("blocks dispatch when Zotero tool discovery is incomplete", async function () {
    const h = harness();
    h.deps.discoveredTools = () => [];
    const error = await runDshPanelTurn(h.turn, h.panel, h.deps).catch(
      (e) => e,
    );
    assert.match(error.message, /tool discovery failed/);
    assert.isFalse(h.sent.some((m) => m.method === "session/prompt"));
    assert.include(h.cleared, "token-1");
    h.rpc.close();
  });
  it("refuses restore after Home changes and never silently creates a replacement", async function () {
    const h = harness();
    await runDshPanelTurn(h.turn, h.panel, h.deps);
    h.summary().runtimeBinding = "old-home";
    const error = await runDshPanelTurn(h.turn, h.panel, h.deps).catch(
      (e) => e,
    );
    assert.match(error.message, /Home/);
    assert.equal(h.sent.filter((m) => m.method === "session/new").length, 1);
    h.rpc.close();
  });
  it("cancels during session creation and closes a late session without dispatch", async function () {
    const h = harness();
    let opening: any;
    h.setBehavior((m) => {
      if (m.method === "session/new") {
        opening = m;
        return true;
      }
      return false;
    });
    const task = runDshPanelTurn(h.turn, h.panel, h.deps).catch((e) => e);
    while (!opening) await new Promise((r) => setTimeout(r, 0));
    cancelDshConversation(h.turn.conversationKey);
    assert.equal((await task).name, "AbortError");
    h.rpc.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        id: opening.id,
        result: { sessionId: "late" },
      }) + "\n",
    );
    await new Promise((r) => setTimeout(r, 5));
    assert.isTrue(
      h.sent.some(
        (m) => m.method === "session/close" && m.params.sessionId === "late",
      ),
    );
    assert.isFalse(h.sent.some((m) => m.method === "session/prompt"));
    h.rpc.close();
  });
  it("revokes Zotero access before cancellation and rejects concurrent requests", async function () {
    const h = harness();
    let prompt: any;
    h.setBehavior((m) => {
      if (m.method === "session/prompt") {
        prompt = m;
        return true;
      }
      if (m.method === "session/cancel") {
        assert.include(h.cleared, "token-1");
        h.rpc.receive(
          JSON.stringify({
            jsonrpc: "2.0",
            id: prompt.id,
            result: { stopReason: "cancelled" },
          }) + "\n",
        );
      }
      return false;
    });
    const task = runDshPanelTurn(h.turn, h.panel, h.deps).catch((e) => e);
    while (!prompt) await new Promise((r) => setTimeout(r, 0));
    const duplicate = await runDshPanelTurn(h.turn, h.panel, h.deps).catch(
      (e) => e,
    );
    assert.match(duplicate.message, /already running/);
    cancelDshConversation(h.turn.conversationKey);
    bumpConversationWriteGeneration(h.turn.conversationKey);
    assert.equal((await task).name, "AbortError");
    h.rpc.close();
  });
  it("maps only single-use native permission options and cancels outstanding approvals", async function () {
    const request = {
      toolCall: { title: "Write file" },
      options: [
        { kind: "allow_once", optionId: "a" },
        { kind: "reject_once", optionId: "r" },
        { kind: "allow_always", optionId: "never" },
      ],
    };
    const base = { isLive: () => true, onDelta: () => {}, onStatus: () => {} };
    const c = new AbortController();
    const allowed = await answerDshPermission(
      request,
      { ...base, onHostInteraction: async () => ({ approved: true }) },
      c.signal,
    );
    assert.equal(allowed.outcome.optionId, "a");
    const waiting = answerDshPermission(
      request,
      { ...base, onHostInteraction: () => new Promise(() => {}) },
      c.signal,
    );
    c.abort();
    assert.equal((await waiting).outcome.outcome, "cancelled");
  });
  it("does not silently discard unsupported images", function () {
    assert.throws(
      () =>
        buildDshPrompt(
          [
            {
              role: "user",
              content: [
                {
                  type: "image_url",
                  image_url: { url: "data:image/png;base64,aA==" },
                },
              ],
            },
          ],
          false,
          false,
        ),
      /does not accept images/,
    );
  });
  it("routes actual context use, documents and MCP events only to their owning turn", async function () {
    const h = harness();
    let observe: (event: any) => void = () => {};
    h.deps.observeMcp = (callback) => {
      observe = callback;
      return () => {};
    };
    const documents: string[] = [],
      received: any[] = [],
      usage: number[][] = [];
    h.deps.loadDocument = async (runId) => {
      assert.equal(runId, "ui-owned-run");
      return { documentId: "document-owned-by-run" } as any;
    };
    h.setBehavior((m) => {
      if (m.method !== "session/prompt") return false;
      const scope = h.scopes[0];
      assert.equal(scope.sourceMessageTimestamp, 847);
      const event = {
        runId: scope.runId,
        conversationKey: scope.conversationKey,
        conversationGeneration: scope.conversationGeneration,
        phase: "completed",
        ok: true,
        toolName: "submit_document",
      };
      observe({ ...event, runId: "other-run" });
      observe({ ...event, conversationKey: scope.conversationKey + 1 });
      observe({
        ...event,
        conversationGeneration: scope.conversationGeneration + 1,
      });
      observe(event);
      for (const update of [
        { sessionUpdate: "usage_update", used: 123, size: 128000 },
        { sessionUpdate: "usage_update", used: -1, size: 128000 },
      ])
        h.rpc.receive(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "session/update",
            params: { sessionId: m.params.sessionId, update },
          }) + "\n",
        );
      return false;
    });
    await runDshPanelTurn(
      { ...h.turn, runId: "ui-owned-run", sourceMessageTimestamp: 847 },
      {
        ...h.panel,
        onMcpActivity: (event) => received.push(event),
        onContextUsage: (used, size) => usage.push([used, size]),
        onDocument: (id) => documents.push(id),
      },
      h.deps,
    );
    assert.lengthOf(received, 1);
    assert.deepEqual(usage, [[123, 128000]]);
    assert.deepEqual(documents, ["document-owned-by-run"]);
    assert.isTrue(h.scopes[0].signal.aborted);
    h.rpc.close();
  });
  it("enriches native approvals with the tool operation and avoids duplicate Zotero traces", async function () {
    const h = harness();
    const approvals: any[] = [],
      activity: any[] = [];
    h.setBehavior((m) => {
      if (m.method === "session/prompt") {
        for (const update of [
          {
            sessionUpdate: "tool_call",
            toolCallId: "native",
            title: "Write requested file",
            rawInput: { file_path: "C:/test.txt", content: "review me" },
          },
          {
            sessionUpdate: "tool_call",
            toolCallId: "mcp",
            title: "mcp__llm_for_zotero__paper_read",
          },
        ])
          h.rpc.receive(
            JSON.stringify({
              jsonrpc: "2.0",
              method: "session/update",
              params: { sessionId: m.params.sessionId, update },
            }) + "\n",
          );
        h.rpc.receive(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "approval",
            method: "session/request_permission",
            params: {
              sessionId: m.params.sessionId,
              toolCall: { toolCallId: "native" },
              options: [
                { kind: "allow_once", optionId: "allow" },
                { kind: "reject_once", optionId: "deny" },
              ],
            },
          }) + "\n",
        );
        return true;
      }
      if (m.id === "approval" && m.result) {
        assert.equal(m.result.outcome.optionId, "allow");
        const prompt = h.sent.find(
          (entry) => entry.method === "session/prompt",
        );
        h.rpc.receive(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: prompt.params.sessionId,
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId: "native",
                status: "completed",
              },
            },
          }) + "\n",
        );
        h.rpc.receive(
          JSON.stringify({
            jsonrpc: "2.0",
            id: prompt.id,
            result: { stopReason: "end_turn" },
          }) + "\n",
        );
        return true;
      }
      return false;
    });
    await runDshPanelTurn(
      h.turn,
      {
        ...h.panel,
        onActivity: (event) => activity.push(event),
        onHostInteraction: async (action) => {
          approvals.push(action);
          return { approved: true };
        },
      },
      h.deps,
    );
    assert.lengthOf(approvals, 1);
    assert.include(approvals[0].title, "Write requested file");
    assert.include(approvals[0].fields[0].value, "C:/test.txt");
    assert.lengthOf(activity, 2);
    assert.deepEqual(
      activity.map((event) => event.phase),
      ["started", "completed"],
    );
    assert.isTrue(
      activity.every((event) => event.toolName === "Write requested file"),
    );
    h.rpc.close();
  });
  it("keeps a committed receipt arriving during cancellation and marks missing outcomes for review", async function () {
    const h = harness();
    let observe: (event: any) => void = () => {};
    const received: any[] = [];
    h.deps.observeMcp = (callback) => {
      observe = callback;
      return () => {};
    };
    let prompt: any, pending: any;
    h.setBehavior((m) => {
      if (m.method === "session/prompt") {
        prompt = m;
        const scope = h.scopes[0];
        pending = {
          runId: scope.runId,
          conversationKey: scope.conversationKey,
          conversationGeneration: scope.conversationGeneration,
          requestId: "write-1",
          toolName: "note_write",
          phase: "started",
        };
        observe(pending);
        observe({ ...pending, requestId: "write-2" });
        return true;
      }
      if (m.method === "session/cancel") {
        observe({
          ...pending,
          phase: "completed",
          ok: true,
          actionReceipts: [{ id: "committed-note" }],
        });
        h.rpc.receive(
          JSON.stringify({
            jsonrpc: "2.0",
            id: prompt.id,
            result: { stopReason: "cancelled" },
          }) + "\n",
        );
      }
      return false;
    });
    const task = runDshPanelTurn(
      h.turn,
      {
        ...h.panel,
        isLive: () => !h.scopes[0]?.signal.aborted,
        onMcpActivity: (event) => received.push(event),
      },
      h.deps,
    ).catch((e) => e);
    while (!prompt) await new Promise((r) => setTimeout(r, 0));
    cancelDshConversation(h.turn.conversationKey);
    assert.equal((await task).name, "AbortError");
    assert.isTrue(
      received.some(
        (event) => event.actionReceipts?.[0].id === "committed-note",
      ),
    );
    assert.isTrue(
      received.some(
        (event) =>
          event.requestId === "write-2" && /结果待核对/.test(event.error || ""),
      ),
    );
    h.rpc.close();
  });
  it("marks a process exit as interruption, revokes the scope and never replays", async function () {
    const h = harness();
    h.setBehavior((m) => {
      if (m.method !== "session/prompt") return false;
      h.rpc.close();
      return true;
    });
    const error = await runDshPanelTurn(h.turn, h.panel, h.deps).catch(
      (e) => e,
    );
    assert.match(error.message, /process exited.*interrupted/);
    assert.include(h.cleared, "token-1");
    assert.equal(h.sent.filter((m) => m.method === "session/new").length, 1);
    assert.equal(h.sent.filter((m) => m.method === "session/prompt").length, 1);
  });
});
