import type { ConversationSystem } from "../shared/types";
import {
  getConversationSystemPref,
  setConversationSystemPref,
} from "../claudeCode/prefs";
import { setDshModeEnabled } from "./prefs";

type DshModePreferenceChangeDeps = {
  setDshModeEnabled: (enabled: boolean) => void;
  getConversationSystemPref: () => ConversationSystem;
  setConversationSystemPref: (system: ConversationSystem) => void;
};

export function applyDshModePreferenceChange(
  enabled: boolean,
  deps: DshModePreferenceChangeDeps = {
    setDshModeEnabled,
    getConversationSystemPref,
    setConversationSystemPref,
  },
): void {
  deps.setDshModeEnabled(enabled);
  if (!enabled && deps.getConversationSystemPref() === "dsh") {
    deps.setConversationSystemPref("upstream");
  }
}
