import {
  isGlobalPortalItem,
  isPaperPortalItem,
  resolvePaperPortalBaseItem,
} from "../context/portalItems";
import {
  isClaudeGlobalPortalItem,
  isClaudePaperPortalItem,
  resolveClaudePaperPortalBaseItem,
} from "../../claudeCode/portal";
import {
  isCodexGlobalPortalItem,
  isCodexPaperPortalItem,
  resolveCodexPaperPortalBaseItem,
} from "../../codexAppServer/portal";
import {
  isAntigravityGlobalPortalItem,
  isAntigravityPaperPortalItem,
  resolveAntigravityPaperPortalBaseItem,
} from "../../antigravity/portal";
import {
  isDshGlobalPortalItem,
  isDshPaperPortalItem,
  resolveDshPaperPortalBaseItem,
} from "../../dsh/portal";
import { resolveNoteEditingParentItem } from "./scope";

export function resolveParentItemForNoteTarget(
  item: Zotero.Item,
): Zotero.Item | null {
  if (
    isGlobalPortalItem(item) ||
    isClaudeGlobalPortalItem(item) ||
    isCodexGlobalPortalItem(item) ||
    isAntigravityGlobalPortalItem(item) ||
    isDshGlobalPortalItem(item)
  ) {
    return null;
  }
  if (isPaperPortalItem(item)) return resolvePaperPortalBaseItem(item);
  if (isClaudePaperPortalItem(item)) {
    return resolveClaudePaperPortalBaseItem(item);
  }
  if (isCodexPaperPortalItem(item)) {
    return resolveCodexPaperPortalBaseItem(item);
  }
  if (isDshPaperPortalItem(item)) {
    return resolveDshPaperPortalBaseItem(item);
  }
  if (isAntigravityPaperPortalItem(item)) {
    return resolveAntigravityPaperPortalBaseItem(item);
  }
  const noteParentItem = resolveNoteEditingParentItem(item);
  if (noteParentItem) return noteParentItem;
  if ((item as any).isNote?.()) return null;
  if (item.isAttachment() && item.parentID) {
    return Zotero.Items.get(item.parentID) || null;
  }
  return item;
}
