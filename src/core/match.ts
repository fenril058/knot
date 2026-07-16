const KATAKANA_START = 0x30a1;
const KATAKANA_END = 0x30f6;
const KANA_OFFSET = 0x60;

/** マッチ用に小文字化し、カタカナをひらがなへ変換する。 */
export function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[ァ-ヶ]/gu, (character) => {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint < KATAKANA_START || codePoint > KATAKANA_END) {
      return character;
    }
    return String.fromCodePoint(codePoint - KANA_OFFSET);
  });
}

function isWordBoundary(candidate: string, index: number): boolean {
  if (index === 0) return true;
  return !/[\p{L}\p{N}]/u.test(candidate[index - 1]);
}

function scoreToken(token: string, candidate: string): number | null {
  let previous = new Map<number, number>();

  for (let tokenIndex = 0; tokenIndex < token.length; tokenIndex++) {
    const current = new Map<number, number>();
    for (let candidateIndex = 0; candidateIndex < candidate.length; candidateIndex++) {
      if (candidate[candidateIndex] !== token[tokenIndex]) continue;

      const characterScore = 1 + (isWordBoundary(candidate, candidateIndex) ? 6 : 0);
      if (tokenIndex === 0) {
        current.set(candidateIndex, characterScore + (candidateIndex === 0 ? 6 : 0));
        continue;
      }

      let best = Number.NEGATIVE_INFINITY;
      for (const [previousIndex, previousScore] of previous) {
        if (previousIndex >= candidateIndex) continue;
        const consecutiveBonus = previousIndex + 1 === candidateIndex ? 12 : 0;
        best = Math.max(best, previousScore + consecutiveBonus);
      }
      if (best !== Number.NEGATIVE_INFINITY) current.set(candidateIndex, best + characterScore);
    }
    if (current.size === 0) return null;
    previous = current;
  }

  return Math.max(...previous.values());
}

/** クエリの全語が候補に部分列一致したとき、一致の品質を返す。 */
export function fuzzyScore(query: string, candidate: string): number | null {
  const normalizedCandidate = normalizeForMatch(candidate);
  const tokens = normalizeForMatch(query).trim().split(/\s+/u).filter(Boolean);
  let score = 0;

  for (const token of tokens) {
    const tokenScore = scoreToken(token, normalizedCandidate);
    if (tokenScore === null) return null;
    score += tokenScore;
  }

  return score + 1 / (normalizedCandidate.length + 1);
}

/** item の原本を保ったまま、一致スコアと候補文字列で順位付けする。 */
export function rankTitles<T>(
  query: string,
  items: readonly T[],
  getText: (item: T) => string,
  limit = 20,
): T[] {
  const normalizedQuery = normalizeForMatch(query).trim();
  const count = Math.max(0, Math.trunc(limit));
  if (normalizedQuery === '') return items.slice(0, count);

  return items
    .map((item, index) => {
      const text = getText(item);
      return { item, index, text, score: fuzzyScore(normalizedQuery, text) };
    })
    .filter((entry): entry is typeof entry & { score: number } => entry.score !== null)
    .toSorted((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      if (a.text < b.text) return -1;
      if (a.text > b.text) return 1;
      return a.index - b.index;
    })
    .slice(0, count)
    .map((entry) => entry.item);
}
