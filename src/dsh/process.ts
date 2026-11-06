import { CodexAppServerProcess } from "../utils/codexAppServerProcess";
import { pathExists, readFileBytes } from "../utils/geckoFs";
import { getRuntimePlatformInfo } from "../utils/runtimePlatform";
import {
  AcpConnection,
  AcpError,
  validateDshCapabilities,
  type AcpObject,
} from "./protocol";
import {
  getDshBinaryPathPref,
  getDshHomePref,
  getDshNodePathPref,
} from "./prefs";

export function dshEnv(name: string): string {
  const globals = globalThis as any;
  return String(
    globals.Services?.env?.get?.(name) || globals.process?.env?.[name] || "",
  );
}

export function joinDshPath(...parts: string[]): string {
  const paths = (globalThis as any).PathUtils;
  return paths?.join ? paths.join(...parts) : parts.join("/");
}

export type DshLaunch = {
  command: string;
  args: string[];
  home: string;
  identity: string;
  environment: Record<string, string>;
};

/** Resolve npm shims to their script; never run cmd.exe with a composed command. */
export async function resolveDshLaunch(): Promise<DshLaunch> {
  const windows = getRuntimePlatformInfo().platform === "windows";
  const sep = windows ? ";" : ":";
  const search = (dshEnv("PATH") || dshEnv("Path")).split(sep).filter(Boolean);
  const prefix = dshEnv("NPM_CONFIG_PREFIX") || dshEnv("npm_config_prefix");
  const home =
    getDshHomePref() ||
    dshEnv("DSH_HOME") ||
    joinDshPath(dshEnv("USERPROFILE") || dshEnv("HOME"), ".dsh");
  const explicit = getDshBinaryPathPref().replace(/^"|"$/g, "");
  const dirs = [
    ...new Set([
      ...(prefix ? [prefix, joinDshPath(prefix, "bin")] : []),
      ...(windows && dshEnv("APPDATA")
        ? [joinDshPath(dshEnv("APPDATA"), "npm")]
        : []),
      ...search,
      ...(!windows ? ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] : []),
    ]),
  ];
  const candidates = explicit
    ? [explicit]
    : dirs.flatMap((dir) => [
        joinDshPath(
          dir,
          "node_modules",
          "@deepseek-ai",
          "dsh",
          "lib",
          "bin.js",
        ),
        ...(!windows
          ? [
              joinDshPath(
                dir,
                "..",
                "lib",
                "node_modules",
                "@deepseek-ai",
                "dsh",
                "lib",
                "bin.js",
              ),
            ]
          : []),
      ]);
  let script = "";
  for (let candidate of candidates) {
    if (/dsh\.(cmd|ps1)$/i.test(candidate)) {
      candidate = candidate.replace(
        /dsh\.(cmd|ps1)$/i,
        "node_modules/@deepseek-ai/dsh/lib/bin.js",
      );
    }
    if (await pathExists(candidate)) {
      script = candidate;
      break;
    }
  }
  if (!script)
    throw new AcpError(
      "DSH was not found. Install @deepseek-ai/dsh and set its lib/bin.js path in DSH settings if needed.",
    );
  const nodeCandidates = getDshNodePathPref()
    ? [getDshNodePathPref()]
    : [
        ...dirs.map((dir) => joinDshPath(dir, windows ? "node.exe" : "node")),
        ...(windows
          ? [
              joinDshPath(
                dshEnv("ProgramFiles") || "C:\\Program Files",
                "nodejs",
                "node.exe",
              ),
            ]
          : []),
      ];
  let node = "";
  for (const candidate of nodeCandidates) {
    if (await pathExists(candidate)) {
      node = candidate;
      break;
    }
  }
  if (!node)
    throw new AcpError(
      "Node.js ≥24.9.0 was not found. Set the Node executable in DSH settings.",
    );
  const noProxy = [
    ...new Set(
      [
        dshEnv("NO_PROXY"),
        dshEnv("no_proxy"),
        "localhost",
        "127.0.0.1",
        "::1",
      ].filter(Boolean),
    ),
  ].join(",");
  const environment = { DSH_HOME: home, NO_PROXY: noProxy, no_proxy: noProxy };
  // The package version is part of the pool key, so npm upgrades re-handshake.
  const manifest = await readFileBytes(
    script.replace(/[/\\]lib[/\\]bin\.js$/, "/package.json"),
  );
  let version = "unknown";
  try {
    version =
      JSON.parse(new TextDecoder().decode(manifest || new Uint8Array()))
        .version || version;
  } catch {
    /* Handshake still validates the actual runtime. */
  }
  return {
    command: node,
    args: [script, "--profile", "acp"],
    home,
    environment,
    identity: JSON.stringify([
      node,
      script,
      home,
      version,
      noProxy,
      dshEnv("HTTP_PROXY"),
      dshEnv("HTTPS_PROXY"),
    ]),
  };
}

export type DshProcess = {
  rpc: AcpConnection;
  capabilities: AcpObject;
  launch: DshLaunch;
};
const pool = new Map<string, Promise<DshProcess>>();

export async function getDshProcess(launch: DshLaunch): Promise<DshProcess> {
  const existing = pool.get(launch.identity);
  if (existing) {
    const process = await existing;
    if (!process.rpc.closed) return process;
    pool.delete(launch.identity);
  }
  const pending = startDshProcess(launch);
  pool.set(launch.identity, pending);
  try {
    return await pending;
  } catch (error) {
    if (pool.get(launch.identity) === pending) pool.delete(launch.identity);
    throw error;
  }
}

async function startDshProcess(launch: DshLaunch): Promise<DshProcess> {
  const subprocess = await CodexAppServerProcess.loadSubprocessModule();
  const probe = await subprocess.call({
    command: launch.command,
    arguments: ["--version"],
    stderr: "pipe",
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const version = await Promise.race([
      probe.stdout.readString(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new AcpError("Node version check timed out.")),
          10_000,
        );
      }),
    ]);
    validateDshNodeVersion(version || "");
  } finally {
    if (timer) clearTimeout(timer);
    try {
      probe.kill();
    } catch {
      /* Version probe already exited. */
    }
  }
  const proc = await subprocess.call({
    command: launch.command,
    arguments: launch.args,
    environment: launch.environment,
    environmentAppend: true,
    // Gecko Subprocess uses CREATE_NO_WINDOW on Windows.
    stderr: "pipe",
  });
  const rpc = new AcpConnection({
    write: (line) => proc.stdin.write(line),
    kill: () => {
      try {
        proc.kill();
      } catch {
        /* Already exited. */
      }
    },
  });
  void (async () => {
    try {
      while (!rpc.closed) {
        const chunk = await proc.stdout.readString();
        if (!chunk) break;
        rpc.receive(chunk);
      }
      rpc.close();
    } catch (error) {
      rpc.close(new AcpError(`DSH stdout failed: ${String(error)}`));
    }
  })();
  // Always drain stderr to avoid backpressure. It may contain credentials or
  // provider data; only ACP errors are exposed to the UI.
  void (async () => {
    try {
      while (await proc.stderr?.readString?.()) {
        /* drain */
      }
    } catch {
      /* exiting */
    }
  })();
  void proc.wait().then(
    () => rpc.close(),
    () => rpc.close(),
  );
  try {
    const result = await rpc.request(
      "initialize",
      {
        protocolVersion: 1,
        clientInfo: { name: "llm-for-zotero", version: "1" },
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      },
      60_000,
    );
    return { rpc, capabilities: validateDshCapabilities(result), launch };
  } catch (error) {
    rpc.close();
    throw error;
  }
}

export function validateDshNodeVersion(version: string): void {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (
    !match ||
    Number(match[1]) < 24 ||
    (Number(match[1]) === 24 && Number(match[2]) < 9)
  )
    throw new AcpError(
      `DSH requires Node.js ≥24.9.0 (selected executable reports ${version.trim() || "an unknown version"}). Update Node or change the Node path in DSH settings.`,
    );
}

export function shutdownDshProcesses(): void {
  for (const pending of pool.values())
    void pending.then(
      (p) => p.rpc.close(),
      () => {},
    );
  pool.clear();
}
