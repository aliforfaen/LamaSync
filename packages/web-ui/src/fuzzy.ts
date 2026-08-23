/**
 * LAMA-270: dependency-free fuzzy scorer for the command palette.
 *
 * `fuzzyScore(query, text)` returns a non-negative score (higher = better)
 * when `query` matches `text` as a substring or a subsequence, and null when
 * it does not. An empty (or whitespace-only) query matches everything with
 * score 0 so the registry order wins and the palette shows a discoverable
 * default list.
 *
 * Scoring rules:
 *   - substring hits beat subsequence hits by a wide margin;
 *   - an earlier match start scores higher (later starts are penalized);
 *   - a match starting at a word boundary (start of string, or after a
 *     space) gets a bonus;
 *   - for subsequences, consecutive hits are rewarded, gaps are penalized,
 *     and a late overall position is penalized.
 *
 * Query whitespace is ignored for subsequence matching so typo'd, jumbled
 * input ("syncd flder" → "Add synced folder") still lands.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  const t = text.toLowerCase();
  if (q.length === 0) return 0;
  if (q.length > t.length) return null;

  // Strongest signal: the whole query appears verbatim in the text.
  const sub = t.indexOf(q);
  if (sub >= 0) {
    const wordStart = sub === 0 || t[sub - 1] === " ";
    return 1000 + (wordStart ? 200 : 0) - sub;
  }

  // Subsequence: every query char (spaces dropped) appears in order.
  const chars = q.replace(/\s+/g, "");
  if (chars.length > t.length) return null;

  let qi = 0;
  let score = 0;
  let streak = 0;
  let lastMatch = 0;
  for (let ti = 0; ti < t.length && qi < chars.length; ti++) {
    if (t[ti] === chars[qi]) {
      score +=
        4 +
        (streak > 0 ? 10 : 0) +
        (ti === 0 || t[ti - 1] === " " ? 12 : 0);
      streak += 1;
      lastMatch = ti;
      qi += 1;
    } else {
      streak = 0;
      score -= 1;
    }
  }
  if (qi < chars.length) return null;
  return score - lastMatch;
}