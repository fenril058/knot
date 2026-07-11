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

export type CosenseUser = { id: string; name: string; displayName?: string; email?: string };

export type CosenseExport = {
  name?: string;
  displayName?: string;
  exported?: number;
  users?: CosenseUser[];
  pages: CosensePage[];
};

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

export function parseExportFile(data: unknown): CosenseExport {
  if (typeof data !== 'object' || data === null || !Array.isArray((data as { pages?: unknown }).pages)) {
    throw new Error('invalid export: pages array is required');
  }
  const raw = data as CosenseExport;
  raw.pages.forEach((page, i) => {
    if (typeof page !== 'object' || page === null) throw new Error(`invalid export: pages[${i}]`);
    if (typeof page.title !== 'string' || page.title === '') {
      throw new Error(`invalid export: pages[${i}].title is required`);
    }
    if (!Array.isArray(page.lines) || page.lines.length === 0) {
      throw new Error(`invalid export: pages[${i}].lines must be a non-empty array`);
    }
    for (const line of page.lines) {
      if (typeof line !== 'string' && (typeof line !== 'object' || line === null || typeof line.text !== 'string')) {
        throw new Error(`invalid export: pages[${i}] has a malformed line`);
      }
    }
  });
  return raw;
}
