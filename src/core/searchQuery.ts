export type SearchQuery = { words: string[]; excludes: string[] };

const WHITESPACE_RE = /\s/u;

function tokenizeSearchQuery(source: string): string[] {
  const tokens: string[] = [];
  let token = '';
  let quoted = false;
  for (const character of source) {
    if (character === '"') {
      quoted = !quoted;
    } else if (!quoted && WHITESPACE_RE.test(character)) {
      if (token !== '') tokens.push(token);
      token = '';
    } else {
      token += character;
    }
  }
  if (token !== '') tokens.push(token);
  return tokens;
}

export function parseSearchQuery(source: string): SearchQuery {
  const tokens = tokenizeSearchQuery(source);
  const words: string[] = [];
  const excludes: string[] = [];
  for (const token of tokens) {
    if (token.startsWith('-') && token.length > 1) excludes.push(token.slice(1));
    else words.push(token);
  }
  // Cosense は除外語だけの入力を、先頭の - を含む通常の検索語として扱う。
  return words.length === 0 && excludes.length > 0 ? { words: tokens, excludes: [] } : { words, excludes };
}
