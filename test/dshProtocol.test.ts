import { assert } from "chai";
import { AcpConnection, validateDshCapabilities } from "../src/dsh/protocol";
import {
  classifyConversationKey,
  getRuntimeAllocatedConversationKeyRange,
  getConversationKeyRange,
} from "../src/shared/conversationKeySpace";
import { CONVERSATION_SYSTEMS } from "../src/shared/conversationSystems";

function harness() {
  const sent: any[] = [];
  let killed = 0;
  const rpc = new AcpConnection({
    write: (line) => {
      sent.push(JSON.parse(line));
    },
    kill: () => {
      killed++;
    },
  });
  return { rpc, sent, killed: () => killed };
}
const frame = (value: object) =>
  JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n";

describe("DSH ACP protocol", function () {
  it("decodes fragmented and coalesced lines and correlates out-of-order responses", async function () {
    const h = harness();
    const a = h.rpc.request("a", {}),
      b = h.rpc.request("b", {});
    const input =
      frame({ id: 2, result: { value: "二" } }) +
      frame({ id: 1, result: { value: "一" } });
    for (let i = 0; i < input.length; i += 7)
      h.rpc.receive(input.slice(i, i + 7));
    assert.deepEqual(await a, { value: "一" });
    assert.deepEqual(await b, { value: "二" });
    h.rpc.close();
  });
  it("times out requests and ignores their late replies", async function () {
    const h = harness();
    const failure = await h.rpc.request("slow", {}, 5).catch((error) => error);
    assert.match(failure.message, /timed out/);
    const next = h.rpc.request("next", {});
    h.rpc.receive(
      frame({ id: 1, result: { stale: true } }) +
        frame({ id: 2, result: { fresh: true } }),
    );
    assert.deepEqual(await next, { fresh: true });
    h.rpc.close();
  });
  it("isolates sessions, cancels unknown approvals and rejects unsupported client methods", async function () {
    const h = harness(),
      a: string[] = [],
      b: string[] = [];
    h.rpc.subscribe("a", {
      update: (u) => a.push(u.content.text),
      permission: async () => ({
        outcome: { outcome: "selected", optionId: "once" },
      }),
    });
    const off = h.rpc.subscribe("b", {
      update: (u) => b.push(u.content.text),
      permission: async () => ({ outcome: { outcome: "cancelled" } }),
    });
    h.rpc.receive(
      frame({
        method: "session/update",
        params: { sessionId: "a", update: { content: { text: "a" } } },
      }),
    );
    h.rpc.receive(
      frame({
        method: "session/update",
        params: { sessionId: "b", update: { content: { text: "b" } } },
      }),
    );
    off();
    h.rpc.receive(
      frame({
        method: "session/request_permission",
        id: "p",
        params: { sessionId: "b" },
      }),
    );
    h.rpc.receive(
      frame({
        method: "fs/write_text_file",
        id: "fs",
        params: { sessionId: "a" },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(a, ["a"]);
    assert.deepEqual(b, ["b"]);
    assert.equal(
      h.sent.find((m) => m.id === "p").result.outcome.outcome,
      "cancelled",
    );
    assert.equal(h.sent.find((m) => m.id === "fs").error.code, -32601);
    h.rpc.close();
  });
  it("propagates process exit to every in-flight request and closes once", async function () {
    const h = harness();
    const a = h.rpc.request("a", {}).catch((e) => e),
      b = h.rpc.request("b", {}).catch((e) => e);
    h.rpc.close();
    h.rpc.close();
    assert.match((await a).message, /interrupted/);
    assert.match((await b).message, /interrupted/);
    assert.equal(h.killed(), 1);
  });
  it("rejects malformed streams and preserves protocol errors", async function () {
    const h = harness();
    const a = h.rpc.request("a", {}).catch((e) => e);
    h.rpc.receive(
      frame({ id: 1, error: { code: -32001, message: "not authenticated" } }),
    );
    assert.equal((await a).code, -32001);
    h.rpc.receive("not-json\n");
    assert.isTrue(h.rpc.closed);
  });
  it("requires protocol, HTTP MCP, resume and close capabilities", function () {
    const supported = {
      protocolVersion: 1,
      agentCapabilities: {
        mcpCapabilities: { http: true },
        sessionCapabilities: { resume: {}, close: {} },
      },
    };
    assert.isObject(validateDshCapabilities(supported));
    assert.throws(
      () => validateDshCapabilities({ ...supported, protocolVersion: 2 }),
      /version/,
    );
    assert.throws(
      () =>
        validateDshCapabilities({ protocolVersion: 1, agentCapabilities: {} }),
      /HTTP/,
    );
    assert.throws(
      () =>
        validateDshCapabilities({
          protocolVersion: 1,
          agentCapabilities: { mcpCapabilities: { http: true } },
        }),
      /resume/,
    );
  });
});

describe("DSH key bands", function () {
  it("uses the two free bands and keeps every existing runtime disjoint and exact", function () {
    assert.deepEqual(classifyConversationKey(1e15), {
      system: "dsh",
      kind: "global",
    });
    assert.deepEqual(classifyConversationKey(2e15 - 1), {
      system: "dsh",
      kind: "global",
    });
    assert.deepEqual(classifyConversationKey(2e15), {
      system: "dsh",
      kind: "paper",
    });
    assert.deepEqual(classifyConversationKey(3e15 - 1), {
      system: "dsh",
      kind: "paper",
    });
    assert.deepEqual(classifyConversationKey(3e15), {
      system: "claude_code",
      kind: "global",
    });
    for (const system of CONVERSATION_SYSTEMS.filter((s) => s !== "upstream")) {
      for (const kind of ["global", "paper"] as const) {
        const full = getConversationKeyRange(system, kind);
        const allocated = getRuntimeAllocatedConversationKeyRange(
          system,
          kind,
          "profile-f423d",
        );
        assert.isAtLeast(allocated.start, full.start);
        assert.isAtMost(allocated.endExclusive, full.endExclusive);
        assert.isTrue(Number.isSafeInteger(allocated.endExclusive - 1));
        assert.deepEqual(classifyConversationKey(allocated.endExclusive - 1), {
          system,
          kind,
        });
      }
    }
  });
});
