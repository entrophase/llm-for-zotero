/** Kept below the store and panel so clearing can revoke a turn synchronously. */
export const activeDshTurns = new Map<number, () => void>();

export function cancelDshConversation(conversationKey: number): void {
  activeDshTurns.get(conversationKey)?.();
}
