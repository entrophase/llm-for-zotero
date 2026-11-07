import { registerAppQuitBlocker } from "../utils/appQuitBlocker";
import type { AgySession } from "./agyProcess";
import { removePathQuietly } from "../utils/geckoFs";

export type AgySessionWorkspace = { dir: string; settingsPath: string };

export type RetainedAgySession = {
  binding: string;
  nativeId: string;
  token: string;
  workspace: AgySessionWorkspace;
  transport: AgySession;
  clearScope?: () => void;
};

export const agySessions = new Map<number, RetainedAgySession>();
export const activeAgyTurns = new Map<number, () => void>();
const views = new Map<Element, number>();
const releases = new Map<number, ReturnType<typeof setTimeout>>();
const closing = new Map<number, Promise<void>>();
const pendingStarts = new Set<Promise<void>>();
let stopping = false;
let unregisterQuit: (() => void) | undefined;

export function registerAgyShutdown(): void {
  unregisterQuit ??= registerAppQuitBlocker(
    "Antigravity sessions",
    shutdownAgySessions,
  );
}

export function agySessionsStopping(): boolean {
  return stopping;
}

export async function trackAgyStart(start: () => Promise<void>): Promise<void> {
  const task = start();
  pendingStarts.add(task);
  try {
    await task;
  } finally {
    pendingStarts.delete(task);
  }
}

export function closeAgyConversation(
  key: number,
  immediate = false,
  expected = agySessions.get(key),
): Promise<void> {
  if (!expected || agySessions.get(key) !== expected) {
    return closing.get(key) ?? Promise.resolve();
  }
  agySessions.delete(key);
  expected.clearScope?.();
  const task = expected.transport
    .close(immediate)
    .finally(() => removePathQuietly(expected.workspace.dir))
    .finally(() => {
      if (closing.get(key) === task) closing.delete(key);
    });
  closing.set(key, task);
  return task;
}

export function cancelAgyConversation(key: number): void {
  activeAgyTurns.get(key)?.();
  void closeAgyConversation(key, true);
}

export function scheduleAgyRelease(key: number): void {
  if (
    releases.has(key) ||
    !agySessions.has(key) ||
    activeAgyTurns.has(key) ||
    Array.from(views.values()).includes(key)
  )
    return;
  releases.set(
    key,
    setTimeout(() => {
      releases.delete(key);
      if (
        !activeAgyTurns.has(key) &&
        !Array.from(views.values()).includes(key)
      ) {
        void closeAgyConversation(key);
      }
    }, 1_000),
  );
}

export function setAgyConversationView(body: Element, key?: number): void {
  const previous = views.get(body);
  if (previous === key) return;
  views.delete(body);
  if (key && !stopping) {
    views.set(body, key);
    const timer = releases.get(key);
    if (timer) clearTimeout(timer);
    releases.delete(key);
  }
  if (previous) scheduleAgyRelease(previous);
}

export async function shutdownAgySessions(): Promise<void> {
  stopping = true;
  unregisterQuit?.();
  unregisterQuit = undefined;
  views.clear();
  for (const timer of releases.values()) clearTimeout(timer);
  releases.clear();
  for (const cancel of activeAgyTurns.values()) cancel();
  await Promise.allSettled([
    ...pendingStarts,
    ...closing.values(),
    ...Array.from(agySessions.keys(), (key) => closeAgyConversation(key, true)),
  ]);
}
