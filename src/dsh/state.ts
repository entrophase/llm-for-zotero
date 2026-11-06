import { getDshProfileSignature } from "./constants";

export const activeDshGlobalConversationByLibrary = new Map<string, number>();
export const activeDshConversationModeByLibrary = new Map<
  string,
  "paper" | "global"
>();
export const activeDshPaperConversationByPaper = new Map<string, number>();

export function buildDshLibraryStateKey(libraryID: number): string {
  return `${getDshProfileSignature()}:${Math.floor(libraryID)}`;
}

export function buildDshPaperStateKey(
  libraryID: number,
  paperItemID: number,
): string {
  return `${getDshProfileSignature()}:${Math.floor(libraryID)}:${Math.floor(paperItemID)}`;
}
