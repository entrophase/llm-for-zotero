/** Opt-in installed-CLI contract test. No credentials or external models used. */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { once } from "node:events";
import { strict as assert } from "node:assert";
import { AcpConnection, validateDshCapabilities } from "../src/dsh/protocol";

async function main() {
  const entry =
    process.argv[2] ||
    join(
      process.env.APPDATA || "",
      "npm/node_modules/@deepseek-ai/dsh/lib/bin.js",
    );
  await mkdir(resolve("tmp"), { recursive: true });
  const root = await mkdtemp(resolve("tmp/dsh-live-"));
  const home = join(root, "DSH Home"),
    cwd = join(root, "Paper Workspace");
  await mkdir(home);
  await mkdir(cwd);
  const calls: Array<{ method: string; token: string }> = [];
  let modelRequests = 0;
  let nativeProbe = false;
  let nativeAllow = false;
  let nativePermissions = 0;
  const nativePath = join(root, "Native Approval Probe.txt");
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    const body = raw ? JSON.parse(raw) : {};
    if (req.url === "/mcp") {
      calls.push({
        method: body.method,
        token: String(req.headers.authorization || ""),
      });
      const result =
        body.method === "initialize"
          ? {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "test-zotero", version: "1" },
            }
          : body.method === "tools/list"
            ? {
                tools: [
                  {
                    name: "paper_read",
                    description: "Read the current temporary paper",
                    inputSchema: { type: "object", properties: {} },
                    annotations: { readOnlyHint: true },
                  },
                ],
              }
            : body.method === "tools/call"
              ? {
                  content: [
                    {
                      type: "text",
                      text: "TEST_PAPER: a stable reference [p. 1].",
                    },
                  ],
                }
              : {};
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? null, result }));
      return;
    }
    modelRequests++;
    const tool = body.tools?.find((t: any) =>
      nativeProbe
        ? t.function.name === "write"
        : t.function.name.includes("paper_read"),
    );
    if (nativeProbe)
      assert.ok(
        tool?.function.parameters.properties.sandbox_permissions,
        "official DSH advertises file approval escalation",
      );
    const messages = body.messages || [];
    const last = messages.at(-1);
    const isTool = last?.role === "tool";
    const hasPrevious = messages.some(
      (m: any) =>
        m.role === "assistant" &&
        /DSH_FIRST|DSH_RESUMED/.test(JSON.stringify(m.content)),
    );
    const text = hasPrevious ? "DSH_RESUMED [p. 1]" : "DSH_FIRST [p. 1]";
    const delta =
      isTool || !tool
        ? { content: text }
        : {
            tool_calls: [
              {
                index: 0,
                id: `call_${modelRequests}`,
                type: "function",
                function: {
                  name: tool.function.name,
                  arguments: nativeProbe
                    ? JSON.stringify({
                        file_path: nativePath,
                        content: "DSH approval probe",
                        sandbox_permissions: "danger-full-access",
                        justification:
                          "Write only the disposable ACP test marker outside the session workspace.",
                      })
                    : "{}",
                },
              },
            ],
          };
    res.setHeader("content-type", "text/event-stream");
    const chunk = (d: object, finish: string | null = null) =>
      `data: ${JSON.stringify({ id: `chat_${modelRequests}`, object: "chat.completion.chunk", created: 1, model: "dsh-test", choices: [{ index: 0, delta: d, finish_reason: finish }] })}\n\n`;
    res.end(
      chunk({ role: "assistant" }) +
        chunk(delta) +
        chunk({}, isTool || !tool ? "stop" : "tool_calls") +
        "data: [DONE]\n\n",
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as any).port;
  const patch = join(root, "mock.yml");
  await writeFile(
    patch,
    `- id: llm-pi-ai\n  config:\n    providers:\n      zotero-test:\n        api: openai-completions\n        apiKeyEnv: DSH_TEST_KEY\n        baseURL: http://127.0.0.1:${port}/v1\n        models:\n          - id: dsh-test\n            contextWindow: 32768\n            maxTokens: 1024\n            reasoningEfforts: false\n- id: acp\n  config:\n    provider: zotero-test\n    model: dsh-test\n`,
  );
  let child: ReturnType<typeof spawn> | undefined;
  const start = async () => {
    child = spawn(
      process.execPath,
      [entry, "--profile", "acp", "--patch", patch],
      {
        windowsHide: true,
        stdio: "pipe",
        env: {
          ...process.env,
          DSH_HOME: home,
          DSH_TEST_KEY: "mock-key",
          NO_PROXY: "localhost,127.0.0.1,::1",
          no_proxy: "localhost,127.0.0.1,::1",
        },
      },
    );
    const own = child;
    const rpc = new AcpConnection({
      write: (line) => {
        own.stdin!.write(line);
      },
      kill: () => {
        own.kill();
      },
    });
    own.stdout!.setEncoding("utf8");
    own.stdout!.on("data", (chunk) => rpc.receive(chunk));
    let stderr = "";
    own.stderr!.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-5000);
    });
    own.on("exit", () => rpc.close(new Error(`DSH exited: ${stderr}`)));
    own.on("error", (error) => rpc.close(error));
    const initialized = await rpc.request(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: "llm-for-zotero-test", version: "1" },
      },
      60_000,
    );
    validateDshCapabilities(initialized);
    return { rpc, capabilities: initialized.agentCapabilities, pid: own.pid };
  };
  const metrics: any = {
    node: process.version,
    dsh: JSON.parse(
      await readFile(resolve(entry, "../../package.json"), "utf8"),
    ).version,
  };
  let active: Awaited<ReturnType<typeof start>> | undefined;
  let sessionId = "";
  try {
    const t = performance.now();
    active = await start();
    metrics.coldInitializeMs = performance.now() - t;
    const turn = async (token: string, resume: boolean) => {
      const started = performance.now();
      let firstText = 0,
        text = "";
      const opened = await active!.rpc.request(
        resume ? "session/resume" : "session/new",
        {
          ...(resume ? { sessionId } : {}),
          cwd,
          mcpServers: [
            {
              type: "http",
              name: "llm_for_zotero",
              url: `http://127.0.0.1:${port}/mcp`,
              headers: [
                { name: "Authorization", value: `Bearer ${token}` },
                { name: "X-LLM-For-Zotero-Scope", value: token },
              ],
            },
          ],
        },
        180_000,
      );
      sessionId = opened.sessionId || sessionId;
      assert.ok(sessionId);
      const off = active!.rpc.subscribe(sessionId, {
        update: (u) => {
          if (
            u.sessionUpdate === "agent_message_chunk" &&
            u.content?.type === "text"
          ) {
            firstText ||= performance.now() - started;
            text += u.content.text;
          }
        },
        permission: async (req) => {
          if (nativeProbe) nativePermissions++;
          return {
            outcome: {
              outcome: "selected",
              optionId: req.options.find(
                (o: any) =>
                  o.kind ===
                  (nativeProbe && !nativeAllow ? "reject_once" : "allow_once"),
              )?.optionId,
            },
          };
        },
      });
      await active!.rpc.request(
        "session/prompt",
        {
          sessionId,
          prompt: [
            {
              type: "text",
              text: resume
                ? "Continue using the paper tool."
                : "Read the paper tool and remember DSH_FIRST.",
            },
          ],
        },
        60_000,
      );
      off();
      await active!.rpc.request("session/close", { sessionId });
      if (!nativeProbe)
        assert.ok(
          calls.some(
            (c) => c.method === "tools/call" && c.token === `Bearer ${token}`,
          ),
          "DSH used this turn's MCP credential",
        );
      assert.match(text, resume ? /DSH_RESUMED/ : /DSH_FIRST/);
      return {
        firstTextMs: firstText,
        totalMs: performance.now() - started,
        pid: active!.pid,
      };
    };
    metrics.first = await turn("first-token", false);
    metrics.reused = await turn("second-token", true);
    assert.equal(metrics.first.pid, metrics.reused.pid);
    active.rpc.close();
    active = await start();
    metrics.restarted = await turn("third-token", true);
    nativeProbe = true;
    await turn("native-deny", true);
    assert.equal(
      await readFile(nativePath, "utf8").catch(() => null),
      null,
      "denied native operation did not write",
    );
    nativeAllow = true;
    await turn("native-allow", true);
    assert.equal(await readFile(nativePath, "utf8"), "DSH approval probe");
    assert.equal(
      nativePermissions,
      2,
      "each native operation requested its own one-shot approval",
    );
    metrics.nativePermissionRequests = nativePermissions;
    metrics.modelRequests = modelRequests;
    metrics.capabilities = active.capabilities;
    await writeFile(
      resolve("tmp/dsh-live-result.json"),
      JSON.stringify(metrics, null, 2),
    );
    process.stdout.write(JSON.stringify(metrics, null, 2) + "\n");
  } finally {
    active?.rpc.close();
    child?.kill();
    server.close();
  }
}
void main().catch((error) => {
  process.stderr.write(String(error) + "\n");
  process.exitCode = 1;
});
