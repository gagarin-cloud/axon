import { francAll } from "franc-min";

/** Prose shorter than this is too little signal to call a language. */
const MIN_PROSE = 80;

/**
 * Returns the ISO 639-3 code of the prose's language when it is confidently not English,
 * otherwise null. Code, paths and URLs are stripped first — they read as noise to trigram models.
 */
export function nonEnglishLanguage(text: string): string | null {
  const prose = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\S*[/\\._]\S*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (prose.length < MIN_PROSE) return null;

  const scores = francAll(prose, { minLength: MIN_PROSE });
  const [top] = scores;
  if (!top || top[0] === "und" || top[0] === "eng") return null;
  // francAll normalises the best match to 1; English close behind means mixed or ambiguous text.
  const eng = scores.find(([code]) => code === "eng")?.[1] ?? 0;
  return eng >= 0.85 ? null : top[0];
}
