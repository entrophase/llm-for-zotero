import { assert } from "chai";
import {
  resolveDshLaunch,
  getDshProcess,
  shutdownDshProcesses,
  validateDshNodeVersion,
} from "../src/dsh/process";
import { CodexAppServerProcess } from "../src/utils/codexAppServerProcess";
import { config } from "../package.json";

describe("DSH process discovery and reuse", function () {
  const g = globalThis as any;
  let saved: Record<string, any>;
  let version = "0.2.2-rc.1";
  const pref = new Map<string, unknown>();
  beforeEach(function () {
    saved = Object.fromEntries(
      ["Zotero", "IOUtils", "OS", "Services", "PathUtils"].map((key) => [
        key,
        g[key],
      ]),
    );
    version = "0.2.2-rc.1";
    pref.clear();
    g.PathUtils = { join: (...p: string[]) => p.join("/") };
    g.Zotero = { isWin: true, Prefs: { get: (key: string) => pref.get(key) } };
    const env: Record<string, string> = {
      NPM_CONFIG_PREFIX: "C:/User With Spaces/AppData/Roaming/npm",
      APPDATA: "C:/User With Spaces/AppData/Roaming",
      USERPROFILE: "C:/User With Spaces",
      PATH: "C:/Program Files/nodejs",
      HTTPS_PROXY: "http://proxy.invalid:7890",
    };
    g.Services = { env: { get: (name: string) => env[name] || "" } };
    g.IOUtils = {
      exists: async (path: string) =>
        /dsh\/lib\/bin.js$/.test(path) ||
        path === "C:/Program Files/nodejs/node.exe",
      read: async () => new TextEncoder().encode(JSON.stringify({ version })),
    };
  });
  afterEach(function () {
    shutdownDshProcesses();
    for (const [key, value] of Object.entries(saved)) g[key] = value;
  });
  it("resolves the npm entry and Node without a shell, preserves Home and bypasses proxies for loopback", async function () {
    const launch = await resolveDshLaunch();
    assert.equal(launch.command, "C:/Program Files/nodejs/node.exe");
    assert.equal(
      launch.args[0],
      "C:/User With Spaces/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/lib/bin.js",
    );
    assert.deepEqual(launch.args.slice(1), ["--profile", "acp"]);
    assert.include(launch.environment.NO_PROXY, "127.0.0.1");
    assert.include(launch.environment.NO_PROXY, "localhost");
    assert.notProperty(launch.environment, "HTTPS_PROXY"); // inherited unchanged
    pref.set(`${config.prefsPrefix}.dshHome`, "D:/Custom Home");
    pref.set(`${config.prefsPrefix}.dshPath`, "D:/Custom npm/dsh.cmd");
    const override = await resolveDshLaunch();
    assert.equal(override.home, "D:/Custom Home");
    assert.equal(
      override.args[0],
      "D:/Custom npm/node_modules/@deepseek-ai/dsh/lib/bin.js",
    );
  });
  it("validates the Node baseline", function () {
    for (const good of ["v24.9.0", "v24.18.0\n", "v25.0.0"])
      assert.doesNotThrow(() => validateDshNodeVersion(good));
    for (const bad of ["v22.18.0", "v24.8.9", "unknown"])
      assert.throws(() => validateDshNodeVersion(bad), /24.9.0/);
  });
  it("shares a handshake for concurrent callers and repeats it after an installed DSH upgrade", async function () {
    const original = CodexAppServerProcess.loadSubprocessModule;
    let starts = 0;
    CodexAppServerProcess.loadSubprocessModule = async () => ({
      call: async (options: any) => {
        if (options.arguments[0] === "--version")
          return {
            stdout: { readString: async () => "v24.18.0" },
            kill: () => {},
          };
        starts++;
        let read: ((text: string) => void) | undefined;
        let exit: (() => void) | undefined;
        return {
          stdin: {
            write: async (line: string) => {
              const message = JSON.parse(line);
              assert.equal(message.method, "initialize");
              read!(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: message.id,
                  result: {
                    protocolVersion: 1,
                    agentCapabilities: {
                      mcpCapabilities: { http: true },
                      sessionCapabilities: { resume: {}, close: {} },
                    },
                  },
                }) + "\n",
              );
            },
          },
          stdout: {
            readString: () =>
              new Promise<string>((resolve) => {
                read = resolve;
              }),
          },
          stderr: { readString: async () => "" },
          wait: () =>
            new Promise<void>((resolve) => {
              exit = resolve;
            }),
          kill: () => {
            read?.("");
            exit?.();
          },
        };
      },
    });
    try {
      const old = await resolveDshLaunch();
      const [first, same] = await Promise.all([
        getDshProcess(old),
        getDshProcess(old),
      ]);
      assert.strictEqual(first, same);
      assert.equal(starts, 1);
      version = "0.2.3";
      const newer = await resolveDshLaunch();
      assert.notEqual(newer.identity, old.identity);
      const next = await getDshProcess(newer);
      assert.notStrictEqual(first, next);
      assert.equal(starts, 2);
      first.rpc.close();
      next.rpc.close();
    } finally {
      CodexAppServerProcess.loadSubprocessModule = original;
    }
  });
});
