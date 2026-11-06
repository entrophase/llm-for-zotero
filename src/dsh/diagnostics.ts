import { initAgentSubsystem } from "../agent";
import { getUserSkillsRuntimeRootDir } from "../agent/skills/userSkills";
import {
  registerScopedZoteroMcpScope,
  getScopedZoteroMcpDiscoveredTools,
  getZoteroMcpServerUrl,
} from "../agent/mcp/server";
import { ensureDir } from "../utils/geckoFs";
import { getDshProcess, joinDshPath, resolveDshLaunch } from "./process";
import { updateDshConfigOptions } from "./modelCatalog";
import { applyDshOptions } from "./runtime";
import { getDshRuntimeModelPref, getDshEffortPref } from "./prefs";

/** No provider call unless the user separately chooses the model test. */
export async function testDshConnection(
  modelTest: boolean,
  report: (text: string) => void,
): Promise<void> {
  const started = Date.now();
  const process = await getDshProcess(await resolveDshLaunch());
  report(
    `Protocol connected (${Date.now() - started} ms). Checking Zotero tools…`,
  );
  await initAgentSubsystem();
  const scope = registerScopedZoteroMcpScope({
    runtimeAuthority: "dsh",
    runId: `dsh-test-${Date.now()}`,
  });
  let sessionId = "";
  let unsubscribe = () => {};
  try {
    const cwd = joinDshPath(
      getUserSkillsRuntimeRootDir(),
      "dsh",
      "connection-test",
    );
    if (!(await ensureDir(cwd)))
      throw new Error("Cannot create DSH test workspace.");
    const result = await process.rpc.request(
      "session/new",
      {
        cwd,
        mcpServers: [
          {
            type: "http",
            name: "llm_for_zotero",
            url: getZoteroMcpServerUrl(),
            headers: [
              { name: "Authorization", value: `Bearer ${scope.token}` },
              { name: "X-LLM-For-Zotero-Scope", value: scope.token },
            ],
          },
        ],
      },
      180_000,
    );
    sessionId = result.sessionId;
    updateDshConfigOptions(result.configOptions || []);
    if (
      !getScopedZoteroMcpDiscoveredTools(scope.token).includes("library_search")
    ) {
      throw new Error(
        "Protocol connected, but DSH could not discover Zotero tools. Enable the local server and bypass proxies for localhost.",
      );
    }
    report(
      "Protocol connected. Zotero tools available. Model request not tested.",
    );
    if (modelTest) {
      await applyDshOptions(
        process,
        sessionId,
        result.configOptions || [],
        getDshRuntimeModelPref(),
        getDshEffortPref(),
      );
      let text = "";
      unsubscribe = process.rpc.subscribe(sessionId, {
        update: (update) => {
          if (
            update.sessionUpdate === "agent_message_chunk" &&
            update.content?.type === "text"
          )
            text += update.content.text;
        },
        permission: async () => ({ outcome: { outcome: "cancelled" } }),
      });
      report("Protocol connected. Zotero tools available. Testing model…");
      await process.rpc.request(
        "session/prompt",
        {
          sessionId,
          prompt: [
            { type: "text", text: "Reply with DSH_OK. Do not use any tools." },
          ],
        },
        180_000,
      );
      if (!text.trim())
        throw new Error(
          "Model test returned no text. Check DSH authentication and model configuration.",
        );
      report(
        `Protocol connected. Zotero tools available. Model request succeeded (${Date.now() - started} ms).`,
      );
    }
  } catch (error) {
    // An opening that timed out may still create a session without a usable ID.
    if (!sessionId && String(error).includes("timed out")) process.rpc.close();
    throw error;
  } finally {
    scope.clear();
    unsubscribe();
    if (sessionId) {
      try {
        await process.rpc.request("session/close", { sessionId }, 10_000);
      } catch {
        process.rpc.close();
      }
    }
  }
}
