import { createNoteConversationItem } from "../services/notes/conversationItem";
declare const Zotero: any;

import type {
  DshGlobalPortalItem,
  DshPaperPortalItem,
} from "../modules/contextPanel/types";
import { isSupportedContextAttachment } from "../services/paperContent/contextAttachmentSupport";

export function createDshGlobalPortalItem(
  libraryID: number,
  conversationKey: number,
): any {
  const normalizedLibraryID =
    Number.isFinite(libraryID) && libraryID > 0 ? Math.floor(libraryID) : 1;
  const normalizedConversationKey =
    Number.isFinite(conversationKey) && conversationKey > 0
      ? Math.floor(conversationKey)
      : 1;
  const portalItem: DshGlobalPortalItem = {
    __llmDshGlobalPortalItem: true,
    __llmDshConversationKind: "global",
    id: normalizedConversationKey,
    libraryID: normalizedLibraryID,
    parentID: undefined,
    attachmentContentType: "",
    isAttachment: () => false,
    isRegularItem: () => false,
    getAttachments: () => [],
    getField: (field: string) => {
      if (field === "title") return "DSH Chat";
      if (field === "libraryCatalog") return "Library";
      return "";
    },
  };
  return portalItem as any;
}

export function createDshPaperPortalItem(
  basePaperItem: any,
  conversationKey: number,
): any {
  if (basePaperItem?.isNote?.()) {
    return createNoteConversationItem(basePaperItem, "dsh", conversationKey);
  }
  const basePaperItemID =
    Number.isFinite(basePaperItem?.id) && basePaperItem.id > 0
      ? Math.floor(basePaperItem.id)
      : 0;
  const normalizedLibraryID =
    Number.isFinite(basePaperItem?.libraryID) && basePaperItem.libraryID > 0
      ? Math.floor(basePaperItem.libraryID)
      : 1;
  const normalizedConversationKey =
    Number.isFinite(conversationKey) && conversationKey > 0
      ? Math.floor(conversationKey)
      : Math.max(1, basePaperItemID);
  const portalItem: DshPaperPortalItem = {
    __llmDshPaperPortalItem: true,
    __llmDshConversationKind: "paper",
    __llmDshPaperPortalBaseItemID: basePaperItemID,
    id: normalizedConversationKey,
    libraryID: normalizedLibraryID,
    parentID: undefined,
    attachmentContentType: "",
    isAttachment: () => false,
    isRegularItem: () => true,
    getAttachments: () => {
      const resolvedBase = basePaperItemID
        ? Zotero.Items.get(basePaperItemID) || null
        : null;
      if (resolvedBase?.isRegularItem?.()) return resolvedBase.getAttachments();
      if (isSupportedContextAttachment(resolvedBase)) return [basePaperItemID];
      return [];
    },
    getField: (field: string) => {
      const resolvedBase = basePaperItemID
        ? Zotero.Items.get(basePaperItemID) || null
        : null;
      if (resolvedBase) {
        try {
          return String(resolvedBase.getField(field) || "");
        } catch {
          return "";
        }
      }
      if (field === "title") return "DSH Paper Chat";
      return "";
    },
  };
  return portalItem as any;
}

export function isDshGlobalPortalItem(
  item: unknown,
): item is DshGlobalPortalItem {
  return Boolean(
    item &&
    typeof item === "object" &&
    (item as Partial<DshGlobalPortalItem>).__llmDshGlobalPortalItem === true,
  );
}

export function isDshPaperPortalItem(
  item: unknown,
): item is DshPaperPortalItem {
  return Boolean(
    item &&
    typeof item === "object" &&
    (item as Partial<DshPaperPortalItem>).__llmDshPaperPortalItem === true,
  );
}

export function isDshPortalItem(
  item: unknown,
): item is DshGlobalPortalItem | DshPaperPortalItem {
  return isDshGlobalPortalItem(item) || isDshPaperPortalItem(item);
}

export function getDshPaperPortalBaseItemID(item: unknown): number | null {
  if (!isDshPaperPortalItem(item)) return null;
  const value = Number(item.__llmDshPaperPortalBaseItemID);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

export function resolveDshPaperPortalBaseItem(item: any): any {
  const baseItemID = getDshPaperPortalBaseItemID(item);
  if (!baseItemID) return null;
  const resolved = Zotero.Items.get(baseItemID) || null;
  if (resolved?.isRegularItem?.()) return resolved;
  return isSupportedContextAttachment(resolved) ? resolved : null;
}
