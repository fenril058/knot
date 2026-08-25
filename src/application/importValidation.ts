import { StorageError, type ImportLine } from '../storage/types.ts';

export function validateImportLines(pageTitle: string, lines: ImportLine[]): void {
  if (lines.length === 0) throw new StorageError(`page "${pageTitle}" has no lines`);
  const seen = new Set<string>();
  for (const line of lines) {
    if (seen.has(line.id)) throw new StorageError(`duplicate line id in page "${pageTitle}": ${line.id}`);
    seen.add(line.id);
  }
}
