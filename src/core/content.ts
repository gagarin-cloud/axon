import { nonEnglishLanguage } from "./lang.js";
import { countTokens } from "./tokens.js";

/** What a memory's vector is computed from. Every writer and `reembed` must agree on it. */
export function embeddingText(title: string, body: string): string {
  return `${title}\n\n${body}`;
}

/** A memory's size as budgets count it. */
export function contentTokens(title: string, body: string): number {
  return countTokens(`${title}\n${body}`);
}

/** Memories bigger than this get a "consider splitting" warning, and are listed by `review`. */
export const LARGE_MEMORY_TOKENS = 600;

/** Advice on a body just written: too big to read cheaply, or not in English. */
export function memoryWarnings(body: string, tokens: number): string[] {
  const warnings: string[] = [];
  if (tokens > LARGE_MEMORY_TOKENS) {
    warnings.push(`${tokens} tokens — consider splitting into smaller, linked memories so reads stay cheap.`);
  }
  const lang = nonEnglishLanguage(body);
  if (lang)
    warnings.push(`Body looks like "${lang}", not English. It is still searchable, but English is cheaper in tokens.`);
  return warnings;
}
