export type EditorCompletionContext =
  | { kind: 'bracket'; query: string; tokenFrom: number }
  | { kind: 'hash'; query: string; tokenFrom: number };

export function completionContext(textBeforeCursor: string): EditorCompletionContext | null {
  const openBrackets: number[] = [];
  for (let index = 0; index < textBeforeCursor.length; index += 1) {
    const character = textBeforeCursor[index];
    if (character === '[') openBrackets.push(index);
    else if (character === ']') openBrackets.pop();
  }

  const bracketFrom = openBrackets.at(-1);
  if (bracketFrom !== undefined) {
    const tokenFrom = bracketFrom + 1;
    return { kind: 'bracket', query: textBeforeCursor.slice(tokenFrom), tokenFrom };
  }

  const hash = /(?:^|\s)#([^\s#]*)$/u.exec(textBeforeCursor);
  if (hash === null) return null;
  const query = hash[1] ?? '';
  const tokenFrom = textBeforeCursor.length - query.length;
  return { kind: 'hash', query, tokenFrom };
}
