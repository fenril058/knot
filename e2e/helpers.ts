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
    };
  }, text);
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

// テロメアは行の左端 4px と margin 0.5rem を占め、click しても編集は始まらない。
// x = 20 はそれを外して行の文字列先頭を押す位置。
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
