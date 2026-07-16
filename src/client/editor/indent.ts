export function indentLine(text: string): string {
  return ` ${text}`;
}

export function dedentLine(text: string): string {
  return /^[ \t]/.test(text) ? text.slice(1) : text;
}
