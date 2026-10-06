import { expect, type Page } from '@playwright/test';

// login rate limit は ip と name の組で 10 分 10 回なので（src/server/app.ts の loginLimiter）、
// seed 済みアカウントは題材ごとに分ける。password は名前から決まる（e2e/server.ts）。
export async function loginE2eAccount(target: Page, name: string): Promise<void> {
  const response = await target.request.post('/api/knot/session', {
    headers: { 'X-Knot-Client': 'e2e' },
    data: { name, password: `${name}-password` },
  });
  expect(response.ok()).toBe(true);
}

export async function loginProjectE2e(target: Page): Promise<void> {
  await loginE2eAccount(target, 'project-e2e');
}

export async function loginRecoveryE2e(target: Page): Promise<void> {
  await loginE2eAccount(target, 'recovery-e2e');
}

export async function loginDirectEditE2e(target: Page): Promise<void> {
  await loginE2eAccount(target, 'direct-edit-e2e');
}

export async function loginTitleE2e(target: Page): Promise<void> {
  await loginE2eAccount(target, 'title-e2e');
}

// ページを 1 コミットで作る。行 ID は `${title}-line-${index}` で、テストから直接指せる。
export async function createE2ePage(target: Page, title: string, bodyLines: string[]): Promise<void> {
  const texts = [title, ...bodyLines];
  const ops = texts.map((text, index) => ({
    type: 'insert' as const,
    id: `${title}-line-${index}`,
    after: index === 0 ? '_head' : `${title}-line-${index - 1}`,
    text,
  }));
  const response = await target.request.post(`/api/knot/pages/e2e/${title}/commits`, {
    headers: { 'X-Knot-Client': 'e2e' },
    data: { commitId: `${title}-create`, baseVersion: 0, ops },
  });
  expect(response.ok()).toBe(true);
}

export type TextBox = { x: number; y: number; width: number; height: number };

// 1px 単位へ丸める。sub-pixel の端数まで一致を求めると、比べたい「字と位置」ではなく
// inline box の組み立て方の違いを見てしまう。ずれの実測値は px 単位だったので、
// この粒度でも検出できる。
function round(value: number): number {
  return Math.round(value);
}

// 本文行に描かれた文字の矩形。行の箱ではなく文字の矩形を見るので、閲覧表示と
// CodeMirror で DOM 構造が違っても「文字がどこにどう並んでいるか」だけを比べられる。
// テロメアは閲覧表示では行の中、編集表示では gutter にあるので、どちらでも除く。
// y は #editor-root 上端からの相対値。本文より上にある UI の増減と混ざらないようにする。
export async function lineTextBoxes(target: Page): Promise<TextBox[]> {
  const boxes = await target.evaluate(() => {
    const root = document.querySelector('#editor-root');
    if (root === null) throw new Error('editor root is missing');
    const rootTop = root.getBoundingClientRect().top;
    const rows = root.querySelectorAll('.line-row, .cm-line');
    return Array.from(rows, (row) => {
      const rects: DOMRect[] = [];
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      while (walker.nextNode() !== null) {
        const node = walker.currentNode;
        if (node.parentElement?.closest('.telomere') != null) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        rects.push(...Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0));
      }
      // 文字の無い行は両方の表示で 0 になる。空行を題材にするなら、ここではなく
      // 行の箱の高さを別に見る必要がある。
      if (rects.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
      const left = Math.min(...rects.map((rect) => rect.left));
      const right = Math.max(...rects.map((rect) => rect.right));
      const top = Math.min(...rects.map((rect) => rect.top));
      const bottom = Math.max(...rects.map((rect) => rect.bottom));
      return { x: left, y: top - rootTop, width: right - left, height: bottom - top };
    });
  });
  return boxes.map(({ x, y, width, height }) => ({
    x: round(x),
    y: round(y),
    width: round(width),
    height: round(height),
  }));
}

// 同じ行が同じ字・同じ位置で描かれていること。
export function expectSameTextBox(index: number, before: TextBox, after: TextBox): void {
  expect({ index, ...after }).toEqual({ index, ...before });
}

// その文字列だけを持つ葉要素の字の指定。閲覧表示では h1 や div、CodeMirror では
// .cm-line や整形表示の span と、表現が変わっても同じ数え方で観測できる。
export async function textStyleOf(target: Page, text: string): Promise<Record<string, string>> {
  return target.evaluate((expected) => {
    const root = document.querySelector('#editor-root');
    if (root === null) throw new Error('editor root is missing');
    const element = Array.from(root.querySelectorAll<HTMLElement>('*')).find((candidate) =>
      candidate.children.length === 0 && candidate.textContent === expected
    );
    if (element === undefined) throw new Error(`no leaf element renders ${JSON.stringify(expected)}`);
    const style = getComputedStyle(element);
    return {
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      lineHeight: style.lineHeight,
      color: style.color,
    };
  }, text);
}

// 行の箱の高さ。閲覧表示の .line-row と CodeMirror の .cm-line を同じ数え方で測る。
// 文字の無い行（空行）の高さは lineTextBoxes では見えないので、こちらで見る。
export async function rowHeights(target: Page): Promise<number[]> {
  return target.evaluate(() => Array.from(
    document.querySelectorAll('#editor-root .line-row, #editor-root .cm-line'),
    (row) => Math.round(row.getBoundingClientRect().height),
  ));
}

// 行の視覚行ごとの文字の範囲 [left, top, width]。top は #editor-root 上端からの相対値。
// 同じ高さに並ぶ文字の矩形を 1 つにまとめるので、閲覧表示と CodeMirror で文字の区切り方
// （text node の分け方）が違っても、折り返した各行がどこから始まりどこまで続くかを比べられる。
export async function visualLineRects(target: Page): Promise<number[][][]> {
  return target.evaluate(() => {
    const root = document.querySelector('#editor-root');
    if (root === null) throw new Error('editor root is missing');
    const rootTop = root.getBoundingClientRect().top;
    return Array.from(root.querySelectorAll('.line-row, .cm-line'), (row) => {
      const lines = new Map<number, { left: number; right: number }>();
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      while (walker.nextNode() !== null) {
        const node = walker.currentNode;
        if (node.parentElement?.closest('.telomere') != null) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of Array.from(range.getClientRects())) {
          if (rect.width === 0 || rect.height === 0) continue;
          const top = Math.round(rect.top - rootTop);
          const line = lines.get(top);
          lines.set(top, {
            left: Math.min(line?.left ?? rect.left, rect.left),
            right: Math.max(line?.right ?? rect.right, rect.right),
          });
        }
      }
      return Array.from(lines, ([top, { left, right }]) => [Math.round(left), top, Math.round(right - left)])
        .toSorted((a, b) => a[1]! - b[1]!);
    });
  });
}

export type IndentMark = {
  // 字下げした本文の開始位置（0.5px 単位）。
  textLeft: number;
  // 行頭の印。位置は本文の開始位置と行の上端からの相対値。印が無ければ null。
  mark: { x: number; y: number; width: number; height: number; color: string; radius: string } | null;
};

// 字下げした行の、本文の開始位置と行頭の印。字下げの無い行は null。
// 印は本文の要素の ::before なので、要素の矩形と computed style から位置を求める。
export async function indentMarks(target: Page): Promise<(IndentMark | null)[]> {
  return target.evaluate(() => Array.from(
    document.querySelectorAll('#editor-root .line-row, #editor-root .cm-line'),
    (row) => {
      const content = row.querySelector<HTMLElement>('.line-indent-content, .cm-wysiwyg-indent-content');
      if (content === null) return null;
      const box = content.getBoundingClientRect();
      const before = getComputedStyle(content, '::before');
      const shown = before.display !== 'none' && before.content !== 'none';
      return {
        textLeft: Math.round(box.left * 2) / 2,
        mark: shown
          ? {
            x: Number.parseFloat(before.left),
            y: Math.round((box.top - row.getBoundingClientRect().top + Number.parseFloat(before.top)) * 2) / 2,
            width: Number.parseFloat(before.width),
            height: Number.parseFloat(before.height),
            color: before.backgroundColor,
            radius: before.borderRadius,
          }
          : null,
      };
    },
  ));
}

export type PageGeometry = {
  bodyBackground: string;
  bar: { height: number; background: string };
  // y は document 上の位置。scroll に依らず比べられるようにする。
  paper: { x: number; y: number; width: number; background: string; padding: number[] };
  telomereLeft: number;
};

// 紙面（本文を載せる白い領域、.page）と、その周りの観測値。
// テロメアは閲覧表示では行の中、編集表示では gutter にあり、どちらも先頭行のものを測る。
export async function pageGeometry(target: Page): Promise<PageGeometry> {
  return target.evaluate(() => {
    const paper = document.querySelector<HTMLElement>('.page');
    const bar = document.querySelector<HTMLElement>('.page-nav');
    const telomere = document.querySelector<HTMLElement>('#editor-root .telomere');
    if (paper === null || bar === null || telomere === null) throw new Error('page layout element is missing');
    const paperBox = paper.getBoundingClientRect();
    const paperStyle = getComputedStyle(paper);
    return {
      bodyBackground: getComputedStyle(document.body).backgroundColor,
      bar: {
        height: Math.round(bar.getBoundingClientRect().height),
        background: getComputedStyle(bar).backgroundColor,
      },
      paper: {
        x: Math.round(paperBox.left),
        y: Math.round(paperBox.top + window.scrollY),
        width: Math.round(paperBox.width),
        background: paperStyle.backgroundColor,
        padding: [paperStyle.paddingTop, paperStyle.paddingRight, paperStyle.paddingBottom, paperStyle.paddingLeft]
          .map((value) => Math.round(Number.parseFloat(value))),
      },
      telomereLeft: Math.round(telomere.getBoundingClientRect().left),
    };
  });
}

// 長いページの途中を表示した状態を作る。scroll 量を固定値にすると、行の高さが変わったときに
// 対象の行が画面の外へ出る。行そのものを画面の上端から top の位置へ置く。
export async function scrollRowTo(target: Page, rowIndex: number, top: number): Promise<void> {
  await target.locator('#editor-root .line-row').nth(rowIndex).evaluate((row, offset) => {
    window.scrollTo(0, row.getBoundingClientRect().top + window.scrollY - offset);
  }, top);
}

export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolver: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolver = resolve;
  });
  return {
    promise,
    resolve: () => {
      if (resolver === undefined) throw new Error('deferred promise resolver is missing');
      resolver();
    },
  };
}

// 行の左端には紙面の左 padding と同じ幅の余白があり、その先頭 4px がテロメアになる。
// テロメアの click では編集は始まらない。x = 20 はテロメアを外して余白を押す位置で、
// 余白も行の一部なので、その行から編集が始まる。mobile の余白（21px）にも収まる。
export const lineRowClickPosition = { x: 20, y: 8 };

// タイトルが画面上に何個見えているかを数える。閲覧時の見出しも Editor のタイトル行も、
// タイトル文字列だけを持つ葉要素として現れるので、表現が変わっても同じ数え方で観測できる。
export async function visibleTitleCount(target: Page, title: string): Promise<number> {
  return target.evaluate((expected) => {
    const main = document.querySelector('main');
    if (main === null) throw new Error('main element is missing');
    return Array.from(main.querySelectorAll<HTMLElement>('*')).filter((element) =>
      element.children.length === 0
      && element.textContent?.trim() === expected
      && element.checkVisibility()
    ).length;
  }, title);
}

// SSR 本文の行を click して編集を開始する。
// 未作成ページには行が無く、作成ボタンだけが編集開始の面になる。
// 回復ダイアログが挟まる経路ではエディタがすぐ現れないので、待たずに戻る。
export async function startEditing(target: Page, lineIndex = 1): Promise<void> {
  const creationButton = target.locator('#edit-page-button');
  if (await creationButton.count() > 0) {
    await creationButton.click();
    return;
  }
  const rows = target.locator('#editor-root .line-row');
  const count = await rows.count();
  if (count === 0) throw new Error('SSR editor row is missing');
  await rows.nth(Math.min(lineIndex, count - 1)).click({ position: lineRowClickPosition });
}

export async function activateEditor(target: Page, lineIndex = 1): Promise<void> {
  await startEditing(target, lineIndex);
  await expect(target.locator('#editor-root .cm-content')).toBeVisible();
}

export async function replaceEditorDocument(target: Page, texts: string[]): Promise<void> {
  const editor = target.locator('#editor-root .cm-content');
  await editor.click();
  await target.keyboard.press('Control+A');
  await target.keyboard.insertText(texts.join('\n'));
}

// 行が折り返すと Home / End は視覚行の端へ移るので、この置換は 1 行に収まる行だけで使う。
export async function replaceEditorLine(target: Page, index: number, text: string): Promise<void> {
  await target.locator('#editor-root .cm-line').nth(index).click();
  await target.keyboard.press('Home');
  await target.keyboard.press('Shift+End');
  await target.keyboard.insertText(text);
}

export type LinkRowTarget = {
  label: string;
  trailingGap: number;
  trailingHit: 'link' | 'row' | 'outside-viewport';
  rowRight: number;
  x: number;
  y: number;
};

// link だけの行の「行末に残っている、リンクではない面」。閲覧表示の .line-row でも
// CodeMirror の .cm-line でも同じ数え方で測る。
// 折り返しの最後の視覚行を見るのは、そこがリンクの終わりで、行末の面が最も狭くなるため。
export async function linkRowTargets(target: Page): Promise<LinkRowTarget[]> {
  return target.evaluate(() => {
    const root = document.querySelector('#editor-root');
    if (root === null) throw new Error('editor root is missing');
    const targets: LinkRowTarget[] = [];
    for (const row of root.querySelectorAll('.line-row, .cm-line')) {
      const anchors = row.querySelectorAll('a');
      if (anchors.length !== 1) continue;
      const anchor = anchors[0]!;
      if (anchor.textContent !== row.textContent?.trim()) continue;
      const rects = Array.from(anchor.getClientRects());
      const last = rects.at(-1);
      if (last === undefined) continue;
      const rowRect = row.getBoundingClientRect();
      const x = rowRect.right - 12;
      const y = last.top + last.height / 2;
      // elementFromPoint は hit testing の結果で、touch adjustment は含まない。
      // 実際の tap がリンクへ吸い寄せられるかどうかは、これでは分からない（touch の
      // 契約は実 tap で見る）。viewport の外は null を返すので、「リンクではない」と
      // 「画面の外だった」を混ぜないよう別の値にしている。
      const hit = document.elementFromPoint(x, y);
      const trailingHit = hit === null
        ? 'outside-viewport' as const
        : hit.closest('a') === null ? 'row' as const : 'link' as const;
      targets.push({
        label: anchor.textContent ?? '',
        trailingGap: Math.round(rowRect.right - last.right),
        trailingHit,
        rowRight: rowRect.right,
        x,
        y,
      });
    }
    return targets;
  });
}

// 行の 1 本目の視覚行に収まる文字数。折り返しの位置は font と本文の幅で変わるので、
// 「行末ぴったりで終わるラベル」の長さは、動かしている環境で実測して決める。
export async function firstVisualLineLength(target: Page, rowIndex: number): Promise<number> {
  return target.evaluate((index) => {
    const root = document.querySelector('#editor-root');
    if (root === null) throw new Error('editor root is missing');
    const row = root.querySelectorAll('.line-row, .cm-line')[index];
    if (row === undefined) throw new Error(`row ${index} is missing`);
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node !== null && (node.textContent ?? '').trim() === '') node = walker.nextNode();
    if (node === null) throw new Error(`row ${index} has no text`);
    const length = node.textContent?.length ?? 0;
    const range = document.createRange();
    range.setStart(node, 0);
    for (let end = 1; end <= length; end += 1) {
      range.setEnd(node, end);
      if (range.getClientRects().length > 1) return end - 1;
    }
    return length;
  }, rowIndex);
}

// 要素の 1 つ目の矩形の中央。折り返した anchor は bounding box の中央が視覚行の外に
// 落ちることがあり、locator の中央 click / tap では当たらない。
export async function firstRectCenter(target: Page, selector: string): Promise<{ x: number; y: number }> {
  return target.evaluate((value) => {
    const element = document.querySelector(value);
    if (element === null) throw new Error(`${value} is missing`);
    const rect = element.getClientRects()[0];
    if (rect === undefined) throw new Error(`${value} has no rect`);
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, selector);
}

export type BlockLook = {
  height: number;
  label: { x: number; background: string; fontSize: string; color: string } | null;
  band: { x: number; right: number; background: string; borderLeft: string; paddingLeft: string } | null;
  textX: number | null;
  cells: { x: number; background: string; padding: string }[];
};

// 引用・コードブロック・表の行の見た目。札（見出しの名前）、帯（背景を持つ要素）、
// 帯の中の字の開始位置、表のセルを、閲覧表示と CodeMirror で同じ数え方で測る。
export async function blockLooks(target: Page): Promise<BlockLook[]> {
  return target.evaluate(() => Array.from(
    document.querySelectorAll('#editor-root .line-row, #editor-root .cm-line'),
    (row) => {
      const label = row.querySelector<HTMLElement>('.code-block-start, .table-block-start');
      const band = row.querySelector<HTMLElement>('.code-line, blockquote');
      let textX: number | null = null;
      if (band !== null) {
        const walker = document.createTreeWalker(band, NodeFilter.SHOW_TEXT);
        while (walker.nextNode() !== null && textX === null) {
          const range = document.createRange();
          range.selectNodeContents(walker.currentNode);
          const rect = Array.from(range.getClientRects()).find((candidate) => candidate.width > 0);
          if (rect !== undefined) textX = Math.round(rect.left * 2) / 2;
        }
      }
      const labelStyle = label === null ? null : getComputedStyle(label);
      const bandStyle = band === null ? null : getComputedStyle(band);
      return {
        height: Math.round(row.getBoundingClientRect().height * 2) / 2,
        label: label === null || labelStyle === null
          ? null
          : {
            x: Math.round(label.getBoundingClientRect().left * 2) / 2,
            background: labelStyle.backgroundColor,
            fontSize: labelStyle.fontSize,
            color: labelStyle.color,
          },
        band: band === null || bandStyle === null
          ? null
          : {
            x: Math.round(band.getBoundingClientRect().left * 2) / 2,
            right: Math.round(band.getBoundingClientRect().right * 2) / 2,
            background: bandStyle.backgroundColor,
            borderLeft: bandStyle.borderLeft,
            paddingLeft: bandStyle.paddingLeft,
          },
        textX,
        cells: Array.from(row.querySelectorAll('td'), (cell) => {
          const style = getComputedStyle(cell);
          return {
            x: Math.round(cell.getBoundingClientRect().left * 2) / 2,
            background: style.backgroundColor,
            padding: style.padding,
          };
        }),
      };
    },
  ));
}
