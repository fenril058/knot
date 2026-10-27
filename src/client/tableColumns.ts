// 表の列の幅を、行のあいだで揃える（#276）。Cosense と同じく、表ごとに列のいちばん長いセルの字の幅を
// その列のセルの min-width にする。表の行は行ごとに別の table なので、列の幅は CSS だけでは揃わない。
// 幅は head の 1 つの style に書き、閲覧表示と編集表示が同じ規則を使う。閲覧表示を編集表示に差し替えても
// style は残るので、編集を始めても列の幅は変わらない。表は見出しの行番号（table[data-table]）で区別する。

export type TableColumns = Map<string, number[]>;
export type MeasuredTables = Map<string, { widths: number[]; rows: number }>;

const STYLE_ID = 'table-columns';

// root の中の表の行のセルの字の幅を、表と列ごとに測る。rows は測った行の数。
export function measureTableColumns(root: ParentNode): MeasuredTables {
  const measured: MeasuredTables = new Map();
  for (const table of root.querySelectorAll<HTMLTableElement>('table[data-table]')) {
    const key = table.dataset.table;
    if (key === undefined) continue;
    const entry = measured.get(key) ?? { widths: [], rows: 0 };
    entry.rows += 1;
    Array.from(table.querySelectorAll('td'), (cell, index) => {
      // セルの箱ではなく中身の幅を測る。min-width を与えた後で測っても、字の幅は変わらない。
      const range = document.createRange();
      range.selectNodeContents(cell);
      entry.widths[index] = Math.max(entry.widths[index] ?? 0, range.getBoundingClientRect().width);
    });
    measured.set(key, entry);
  }
  return measured;
}

function styleElement(): HTMLStyleElement | null {
  const element = document.getElementById(STYLE_ID);
  return element instanceof HTMLStyleElement ? element : null;
}

// いま style に書いてある列の幅。
export function currentTableColumns(): TableColumns {
  const data = styleElement()?.dataset.widths;
  if (data === undefined) return new Map();
  try {
    const parsed: unknown = JSON.parse(data);
    if (!Array.isArray(parsed)) return new Map();
    const columns: TableColumns = new Map();
    for (const item of parsed) {
      if (!Array.isArray(item) || typeof item[0] !== 'string' || !Array.isArray(item[1])) continue;
      columns.set(item[0], item[1].filter((width: unknown): width is number => typeof width === 'number'));
    }
    return columns;
  } catch {
    return new Map();
  }
}

// 列の幅を style に書く。style は CSP の nonce を付けて作る。
export function writeTableColumns(columns: TableColumns, nonce: string | undefined): void {
  let element = styleElement();
  if (element === null) {
    element = document.createElement('style');
    element.id = STYLE_ID;
    if (nonce !== undefined) element.nonce = nonce;
    document.head.append(element);
  }
  // 編集表示のカーソル行のセル（#293）も、td と同じ幅にする。
  const rules = Array.from(columns, ([key, widths]) => widths.map((width, index) => (
    `#editor-root table[data-table="${CSS.escape(key)}"] td:nth-child(${index + 1}), `
    + `#editor-root .cm-table-cell[data-table="${CSS.escape(key)}"][data-col="${index + 1}"] { min-width: ${width}px; }`
  )).join('\n'));
  element.textContent = rules.join('\n');
  element.dataset.widths = JSON.stringify(Array.from(columns));
}
