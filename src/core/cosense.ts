export type CosenseLine =
  | string
  | { text: string; created?: number; updated?: number; userId?: string; id?: string };

export type CosensePage = {
  id?: string;
  title: string;
  created?: number;
  updated?: number;
  lines: CosenseLine[];
};

type CosenseUser = { id: string; name: string; displayName?: string; email?: string };

export type CosenseExport = {
  name?: string;
  displayName?: string;
  exported?: number;
  users?: CosenseUser[];
  pages: CosensePage[];
};

export class InvalidExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidExportError';
  }
}

/** メタデータが null の行は、インポート時にインポート時刻とインポート実行ユーザーで埋める約束（storage 層が担う）。 */
export type NormalizedLine = {
  id: string | null;
  text: string;
  created: number | null;
  updated: number | null;
  userId: string | null;
};

export function normalizeLines(page: CosensePage): NormalizedLine[] {
  return page.lines.map((line) =>
    typeof line === 'string'
      ? { id: null, text: line, created: null, updated: null, userId: null }
      : {
          id: line.id ?? null,
          text: line.text,
          created: line.created ?? null,
          updated: line.updated ?? null,
          userId: line.userId ?? null,
        },
  );
}

function checkOptional(value: unknown, type: 'number' | 'string', where: string): void {
  if (value !== undefined && typeof value !== type) {
    throw new InvalidExportError(`invalid export: ${where} must be a ${type}`);
  }
}

export function parseExportFile(data: unknown): CosenseExport {
  if (typeof data !== 'object' || data === null || !Array.isArray((data as { pages?: unknown }).pages)) {
    throw new InvalidExportError('invalid export: pages array is required');
  }
  const raw = data as CosenseExport;
  checkOptional(raw.displayName, 'string', 'displayName');
  (raw.users ?? []).forEach((user, i) => {
    if (typeof user !== 'object' || user === null || typeof user.id !== 'string' || typeof user.name !== 'string') {
      throw new InvalidExportError(`invalid export: users[${i}] must have id and name`);
    }
  });
  raw.pages.forEach((page, i) => {
    if (typeof page !== 'object' || page === null) {
      throw new InvalidExportError(`invalid export: pages[${i}] must be an object`);
    }
    if (typeof page.title !== 'string' || page.title === '') {
      throw new InvalidExportError(`invalid export: pages[${i}].title is required`);
    }
    checkOptional(page.id, 'string', `pages[${i}].id`);
    checkOptional(page.created, 'number', `pages[${i}].created`);
    checkOptional(page.updated, 'number', `pages[${i}].updated`);
    if (!Array.isArray(page.lines) || page.lines.length === 0) {
      throw new InvalidExportError(`invalid export: pages[${i}].lines must be a non-empty array`);
    }
    page.lines.forEach((line, j) => {
      if (typeof line === 'string') return;
      if (typeof line !== 'object' || line === null || typeof line.text !== 'string') {
        throw new InvalidExportError(`invalid export: pages[${i}].lines[${j}] must be a string or an object with text`);
      }
      checkOptional(line.id, 'string', `pages[${i}].lines[${j}].id`);
      checkOptional(line.created, 'number', `pages[${i}].lines[${j}].created`);
      checkOptional(line.updated, 'number', `pages[${i}].lines[${j}].updated`);
      checkOptional(line.userId, 'string', `pages[${i}].lines[${j}].userId`);
    });
  });
  return structuredClone(raw);
}
