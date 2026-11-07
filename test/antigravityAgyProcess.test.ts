import { PassThrough } from "node:stream";
import { assert } from "chai";
import {
  buildAgyArguments,
  openAgySession,
  runAgyTurn,
} from "../src/antigravity/agyProcess";
import { CodexAppServerProcess } from "../src/utils/codexAppServerProcess";
import {
  activeAgyTurns,
  agySessions,
  closeAgyConversation,
  scheduleAgyRelease,
  setAgyConversationView,
} from "../src/antigravity/sessionPool";

/** A child like agy 1.4.2: it stays alive after its result until killed. */
function lingeringAgy(lines: string[]) {
  const kills: number[] = [];
  let exited = false;
  const waiters: Array<() => void> = [];
  const exit = () => {
    exited = true;
    waiters.splice(0).forEach((resolve) => resolve());
  };
  const untilExit = () =>
    new Promise<void>((resolve) => {
      if (exited) resolve();
      else waiters.push(resolve);
    });
  const pending = lines.map((line) => `${line}\n`);
  const proc = {
    stdin: { write: async () => undefined, close: async () => undefined },
    stdout: {
      readString: async () => {
        const next = pending.shift();
        if (next !== undefined) return next;
        await untilExit();
        return "";
      },
    },
    stderr: {
      readString: async () => {
        await untilExit();
        return "";
      },
    },
    wait: async () => {
      await untilExit();
      return { exitCode: -9 };
    },
    kill: (timeout: number) => {
      kills.push(timeout);
      exit();
      return Promise.resolve({ exitCode: -9 });
    },
  };
  return { proc, kills, isExited: () => exited };
}

describe("Antigravity agy turn process", function () {
  const original = CodexAppServerProcess.loadSubprocessModule;
  afterEach(function () {
    CodexAppServerProcess.loadSubprocessModule = original;
  });

  it("keeps the session while either view or an active turn owns the conversation", async function () {
    const key = 401;
    const sidebar = {} as Element;
    const window = {} as Element;
    let closed = false;
    let reportClosed!: () => void;
    const didClose = new Promise<void>((resolve) => {
      reportClosed = resolve;
    });
    agySessions.set(key, {
      binding: "test",
      nativeId: "native",
      token: "fixture",
      workspace: { dir: "", settingsPath: "" },
      transport: {
        reusable: true,
        send: async () => {
          throw new Error("Unexpected send");
        },
        close: async () => {
          closed = true;
          reportClosed();
        },
      },
    });
    try {
      setAgyConversationView(sidebar, key);
      setAgyConversationView(window, key);
      setAgyConversationView(sidebar, key + 1);
      await new Promise((resolve) => setTimeout(resolve, 1050));
      assert.isFalse(closed);
      activeAgyTurns.set(key, () => undefined);
      setAgyConversationView(window);
      await new Promise((resolve) => setTimeout(resolve, 1050));
      assert.isFalse(closed);
      activeAgyTurns.delete(key);
      scheduleAgyRelease(key);
      await didClose;
      assert.isFalse(agySessions.has(key));
    } finally {
      activeAgyTurns.delete(key);
      setAgyConversationView(sidebar);
      setAgyConversationView(window);
      await closeAgyConversation(key);
    }
  });

  it("uses a single child for ten turns and accounts for cumulative usage once", async function () {
    const output = new PassThrough();
    output.setEncoding("utf8");
    const reader = output[Symbol.asyncIterator]();
    let launches = 0;
    let turns = 0;
    let closed = false;
    CodexAppServerProcess.loadSubprocessModule = async () => ({
      pathSearch: async () => "reg.exe",
      call: async ({ command }: { command: string }) => {
        if (/reg\.exe$|scutil$/.test(command)) {
          return {
            stdout: { readString: async () => "" },
            wait: async () => ({ exitCode: 0 }),
          };
        }
        launches++;
        return {
          stdin: {
            async write() {
              turns++;
              if (turns === 1)
                output.write('{"event":"init","conversation_id":"c1"}\n');
              output.write(
                JSON.stringify({
                  event: "result",
                  conversation_id: "c1",
                  status: "SUCCESS",
                  response: `Answer ${turns}`,
                  num_turns: turns,
                  usage: { input_tokens: turns * 11, output_tokens: turns * 3 },
                }) + "\n",
              );
            },
            async close() {
              closed = true;
              output.end();
            },
          },
          stdout: { readString: async () => (await reader.next()).value ?? "" },
          wait: async () => ({ exitCode: 0 }),
        };
      },
    });
    const session = await openAgySession({ binaryPath: "/opt/agy" });
    try {
      for (let turn = 1; turn <= 10; turn++) {
        const result = await session.send({
          prompt: `Question ${turn}`,
          onEvent: () => undefined,
        });
        assert.equal(result.response, `Answer ${turn}`);
        assert.deepInclude(result.usage, {
          input_tokens: 11,
          output_tokens: 3,
        });
        assert.isTrue(session.reusable);
      }
      assert.equal(launches, 1);
      assert.isFalse(closed);
    } finally {
      await session.close();
    }
    assert.isTrue(closed);
  });

  it("ends agy once the result is in instead of waiting for it to exit", async function () {
    this.timeout(2000);
    const child = lingeringAgy([
      JSON.stringify({ event: "init", conversation_id: "c1", init: {} }),
      JSON.stringify({
        event: "result",
        result: { conversation_id: "c1", status: "SUCCESS", response: "Hi" },
      }),
    ]);
    CodexAppServerProcess.loadSubprocessModule = async () => ({
      pathSearch: async () => "C:/Windows/System32/reg.exe",
      call: async (opts: any) => {
        if (
          opts?.command?.endsWith("reg.exe") ||
          opts?.command === "/usr/sbin/scutil"
        ) {
          return {
            stdout: { readString: async () => "" },
            stderr: { readString: async () => "" },
            wait: async () => ({ exitCode: 0 }),
          };
        }
        return child.proc;
      },
    });
    const result = await runAgyTurn({
      binaryPath: "/opt/agy",
      prompt: "Hello",
      onEvent: () => undefined,
    });
    assert.equal(result.response, "Hi");
    assert.isTrue(child.isExited());
    assert.isAbove(child.kills.length, 0);
    assert.isAbove(child.kills[0], 0, "SIGTERM is followed by SIGKILL");
  });

  it("opens extra folders to agy with --add-dir", function () {
    const args = buildAgyArguments({ addDirs: ["/tmp/ctx", " "] });
    assert.deepEqual(args.slice(-2), ["--add-dir", "/tmp/ctx"]);
    assert.equal(args.filter((arg) => arg === "--add-dir").length, 1);
  });

  it("cancels a child returned after the turn was aborted without writing a prompt", async function () {
    const abort = new AbortController();
    let writes = 0;
    let kills = 0;
    CodexAppServerProcess.loadSubprocessModule = async () => ({
      pathSearch: async () => "C:/Windows/System32/reg.exe",
      call: async (options: { command: string }) => {
        if (
          options.command.endsWith("reg.exe") ||
          options.command.endsWith("scutil")
        ) {
          return {
            stdout: { readString: async () => "" },
            wait: async () => ({ exitCode: 0 }),
          };
        }
        abort.abort();
        return {
          stdin: {
            write: async () => {
              writes++;
            },
            close: async () => undefined,
          },
          stdout: { readString: async () => "" },
          stderr: { readString: async () => "" },
          wait: async () => ({ exitCode: -1 }),
          kill: () => {
            kills++;
          },
        };
      },
    });
    const failure = await runAgyTurn({
      binaryPath: "C:/Tools/agy.exe",
      prompt: "Cancelled prompt",
      signal: abort.signal,
      onEvent: () => undefined,
    }).catch((error: Error) => error);
    assert.instanceOf(failure, Error);
    assert.equal((failure as Error).name, "AbortError");
    assert.equal(writes, 0);
    assert.isAbove(kills, 0);
  });

  it("flushes trailing result without newline on stream EOF", async function () {
    let drained = false;
    const proc = {
      stdin: { write: async () => undefined, close: async () => undefined },
      stdout: {
        readString: async () => {
          if (!drained) {
            drained = true;
            return JSON.stringify({
              event: "result",
              result: {
                conversation_id: "c2",
                status: "SUCCESS",
                response: "Done without newline",
              },
            }); // Note: no trailing \n
          }
          return "";
        },
      },
      stderr: { readString: async () => "" },
      wait: async () => ({ exitCode: 0 }),
      kill: () => undefined,
    };
    CodexAppServerProcess.loadSubprocessModule = async () => ({
      call: async () => proc,
    });
    const result = await runAgyTurn({
      binaryPath: "/opt/agy",
      prompt: "Hello",
      onEvent: () => undefined,
    });
    assert.equal(result.response, "Done without newline");
  });

  it("throws when result status is ERROR even if partial response text is present", async function () {
    const child = lingeringAgy([
      JSON.stringify({
        event: "result",
        result: {
          conversation_id: "c3",
          status: "ERROR",
          response: "Partial text before error",
          error: "Model rate limit exceeded",
        },
      }),
    ]);
    CodexAppServerProcess.loadSubprocessModule = async () => ({
      pathSearch: async () => "C:/Windows/System32/reg.exe",
      call: async (opts: any) => {
        if (
          opts?.command?.endsWith("reg.exe") ||
          opts?.command === "/usr/sbin/scutil"
        ) {
          return {
            stdout: { readString: async () => "" },
            stderr: { readString: async () => "" },
            wait: async () => ({ exitCode: 0 }),
          };
        }
        return child.proc;
      },
    });
    try {
      await runAgyTurn({
        binaryPath: "/opt/agy",
        prompt: "Hello",
        onEvent: () => undefined,
      });
      assert.fail("Should have thrown");
    } catch (error: any) {
      assert.include(error.message, "Model rate limit exceeded");
    }
  });
});
