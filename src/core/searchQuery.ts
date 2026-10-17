export type SearchQuery = { words: string[]; excludes: string[] };

const WHITESPACE_RE = /\s/u;

function tokenizeSearchQuery(source: string): string[] {
  // 構文文字の判定には書記素ではなく code point 単位の走査で足りる。
  // oxlint-disable-next-line typescript/no-misused-spread
  const characters = [...source];
  const tokens: string[] = [];
  let index = 0;
  while (index < characters.length) {
    const character = characters[index]!;
    if (WHITESPACE_RE.test(character)) {
      index += 1;
      continue;
    }

    const excludedPhrase = character === '-' && characters[index + 1] === '"';
    if (character === '"' || excludedPhrase) {
      const quoteIndex = index + (excludedPhrase ? 1 : 0);
      const closingQuote = characters.indexOf('"', quoteIndex + 1);
      if (closingQuote !== -1) {
        const phrase = characters.slice(quoteIndex + 1, closingQuote).join('');
        const nextCharacter = characters[closingQuote + 1];
        if (phrase !== '' || nextCharacter === undefined || WHITESPACE_RE.test(nextCharacter)) {
          tokens.push(`${excludedPhrase ? '-' : ''}${phrase}`);
          index = closingQuote + 1;
          continue;
        }
      }
    }

    let token = '';
    while (index < characters.length && !WHITESPACE_RE.test(characters[index]!)) {
      token += characters[index]!;
      index += 1;
    }
    const excluded = token.startsWith('-');
    let body = excluded ? token.slice(1) : token;
    if (body.startsWith('"')) body = body.slice(1);
    if (body.endsWith('"')) body = body.slice(0, -1);
    token = `${excluded ? '-' : ''}${body}`;
    tokens.push(token);
  }
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

// 検索語の上限。全文検索の API と、検索の結果ページ（#247）が同じ規則で受け付ける。
const MAX_SEARCH_QUERY_CODE_POINTS = 1_000;
const MAX_SEARCH_TERMS = 32;

export type SearchQueryProblem = 'required' | 'too_long' | 'too_many_terms';
export type CheckedSearchQuery = { ok: true; query: SearchQuery } | { ok: false; problem: SearchQueryProblem; message: string };

export function checkSearchQuery(source: string): CheckedSearchQuery {
  if (source.trim() === '') return { ok: false, problem: 'required', message: 'q required' };
  // oxlint-disable-next-line typescript/no-misused-spread -- 上限は code point 数で数える。書記素単位の精度は要らない
  if ([...source].length > MAX_SEARCH_QUERY_CODE_POINTS) return { ok: false, problem: 'too_long', message: 'q too long' };
  const query = parseSearchQuery(source);
  if (query.words.length + query.excludes.length > MAX_SEARCH_TERMS) {
    return { ok: false, problem: 'too_many_terms', message: 'too many search terms' };
  }
  return { ok: true, query };
}
