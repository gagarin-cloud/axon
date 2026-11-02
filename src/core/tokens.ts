import { countTokens as count } from "gpt-tokenizer";

/**
 * Token count under o200k_base. Not the exact tokenizer of every client model, but a close,
 * consistent proxy for budgeting.
 */
export function countTokens(text: string): number {
  return text ? count(text) : 0;
}
