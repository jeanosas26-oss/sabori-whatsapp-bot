import type Anthropic from "@anthropic-ai/sdk";

export type ConversationMessage = Anthropic.MessageParam;

const MAX_HISTORY = 20;
const TTL_MS = 30 * 60 * 1000;

interface ConversationEntry {
  messages: ConversationMessage[];
  lastActivity: number;
}

const store = new Map<string, ConversationEntry>();

function cleanup() {
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    if (now - entry.lastActivity > TTL_MS) {
      store.delete(key);
    }
  }
}

setInterval(cleanup, TTL_MS);

export function getHistory(phoneNumber: string): ConversationMessage[] {
  return store.get(phoneNumber)?.messages ?? [];
}

export function appendMessages(
  phoneNumber: string,
  newMessages: ConversationMessage[],
): void {
  const existing = store.get(phoneNumber);
  const messages = existing ? [...existing.messages, ...newMessages] : [...newMessages];
  const trimmed = messages.slice(-MAX_HISTORY);
  store.set(phoneNumber, { messages: trimmed, lastActivity: Date.now() });
}

export function clearHistory(phoneNumber: string): void {
  store.delete(phoneNumber);
}
