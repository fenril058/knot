import { test, expect, type Locator, type Page } from '@playwright/test';
import { charPoint, createE2ePage, lineRowClickPosition, loginE2eAccount } from './helpers.ts';

// 本文の行を押した位置に caret を置く（#243）。Cosense で観測した位置と同じ規則で、字の左半分を
// 押せば字の前、右半分なら後ろ。装飾・インラインコードの中の字は原文の対応する位置、字より右の
// 余白は行末（] の後ろ）、字下げは 1 段を 1 字として扱う。
// caret の位置は、押した後に打った | が保存された原文のどこに入ったかで見る。

const CODE_ROW = 'テキストを`[`と`]`で囲むことを[ブラケティング]と呼んでる';
const DECO_ROW = ' `[* 強調]` ⇒ [* 強調]';

// 字下げの全角空白（1 段）の箱で、左端から fraction の位置。
async function indentPoint(row: Locator, fraction: number): Promise<{ x: number; y: number }> {
  return row.locator('.line-indent-prefix').evaluate((prefix, ratio) => {
    const box = prefix.getBoundingClientRect();
    return { x: box.left + 22.5 * ratio, y: box.top + 14 };
  }, fraction);
}

// 行の字より右の余白。
async function trailingPoint(row: Locator): Promise<{ x: number; y: number }> {
  const box = await row.boundingBox();
  if (box === null) throw new Error('row has no box');
  return { x: box.x + box.width - 60, y: box.y + 14 };
}

async function persistedLines(page: Page, title: string): Promise<string[]> {
  await expect(page.locator('#save-status')).toHaveText('保存済み');
  const response = await page.request.get(`/api/pages/e2e/${title}`);
  return (await response.json()).lines.map((line: { text: string }) => line.text);
}

type Case = {
  row: number;
  point: (row: Locator) => Promise<{ x: number; y: number }>;
  expected: string;
};

// 行 1〜3 は CODE_ROW、行 4〜8 は DECO_ROW。1 つの行で 1 回だけ押すので、押す前の行はどれも原文のまま。
const BODY = [CODE_ROW, CODE_ROW, CODE_ROW, DECO_ROW, DECO_ROW, DECO_ROW, DECO_ROW, DECO_ROW, 'last body'];
const CASES: Case[] = [
  { row: 1, point: (row) => charPoint(row, 'ス', 0, 0.25), expected: 'テキ|ストを`[`と`]`で囲むことを[ブラケティング]と呼んでる' },
  { row: 2, point: (row) => charPoint(row, 'ス', 0, 0.75), expected: 'テキス|トを`[`と`]`で囲むことを[ブラケティング]と呼んでる' },
  { row: 3, point: (row) => charPoint(row, '[', 0, 0.75), expected: 'テキストを`[|`と`]`で囲むことを[ブラケティング]と呼んでる' },
  { row: 4, point: (row) => charPoint(row, '強', 1, 0.25), expected: ' `[* 強調]` ⇒ [* |強調]' },
  { row: 5, point: (row) => charPoint(row, '調', 1, 0.75), expected: ' `[* 強調]` ⇒ [* 強調|]' },
  { row: 6, point: trailingPoint, expected: ' `[* 強調]` ⇒ [* 強調]|' },
  { row: 7, point: (row) => indentPoint(row, 0.25), expected: '| `[* 強調]` ⇒ [* 強調]' },
  { row: 8, point: (row) => indentPoint(row, 0.75), expected: ' |`[* 強調]` ⇒ [* 強調]' },
];

test('閲覧表示の行を押して編集を始めると、押した字の位置に caret が入る', async ({ page }, testInfo) => {
  await loginE2eAccount(page, 'caret-e2e');
  const title = `caret-ssr-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  await createE2ePage(page, title, BODY);
  await page.setViewportSize({ width: 1280, height: 800 });

  const expected = [title, ...BODY];
  for (const entry of CASES) {
    // 1 回ごとに閲覧表示から始める。
    await page.goto(`/e2e/${title}`);
    const row = page.locator('#editor-root .line-row').nth(entry.row);
    const point = await entry.point(row);
    await page.mouse.click(point.x, point.y);
    await expect(page.locator('#editor-root .cm-content')).toBeFocused();
    await page.keyboard.insertText('|');
    expected[entry.row] = entry.expected;
    expect(await persistedLines(page, title)).toEqual(expected);
  }
});

test('編集表示で整形表示の行を押すと、押した字の位置に caret が入る', async ({ page }, testInfo) => {
  await loginE2eAccount(page, 'caret-e2e');
  const title = `caret-active-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  await createE2ePage(page, title, BODY);
  await page.setViewportSize({ width: 1280, height: 800 });

  await page.goto(`/e2e/${title}`);
  // タイトル行から編集を始めて、本文の行はすべて整形表示のまま押す。
  await page.locator('#editor-root .line-row').first().click({ position: lineRowClickPosition });
  await expect(page.locator('#editor-root .cm-content')).toBeFocused();
  const expected = [title, ...BODY];
  for (const entry of CASES) {
    const row = page.locator('#editor-root .cm-line').nth(entry.row);
    await expect(row.locator('.cm-wysiwyg-line')).toHaveCount(1);
    const point = await entry.point(row);
    await page.mouse.click(point.x, point.y);
    await page.keyboard.insertText('|');
    expected[entry.row] = entry.expected;
    expect(await persistedLines(page, title)).toEqual(expected);
  }
});

test('閲覧表示の後でサーバの行が変わっていたら、押した位置ではなく本文の先頭に caret が入る', async ({ page }, testInfo) => {
  await loginE2eAccount(page, 'caret-e2e');
  const title = `caret-stale-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  await createE2ePage(page, title, [' 閲覧表示の本文', 'last body']);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/e2e/${title}`);

  // 閲覧表示を描いた後で、同じ行を別の内容へ書き換える。
  const response = await page.request.post(`/api/knot/pages/e2e/${title}/commits`, {
    headers: { 'X-Knot-Client': 'e2e' },
    data: { commitId: `${title}-update`, baseVersion: 1, ops: [{ type: 'update', id: `${title}-line-1`, text: ' 書き換えた本文' }] },
  });
  expect(response.ok()).toBe(true);

  const point = await charPoint(page.locator('#editor-root .line-row').nth(1), '表', 0, 0.75);
  await page.mouse.click(point.x, point.y);
  await expect(page.locator('#editor-root .cm-content')).toBeFocused();
  await page.keyboard.insertText('|');
  expect((await persistedLines(page, title))[1]).toBe(' |書き換えた本文');
});

test('押した位置に caret を置いても、リンクの click は遷移する', async ({ page }, testInfo) => {
  await loginE2eAccount(page, 'caret-e2e');
  const title = `caret-link-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  await createE2ePage(page, title, [CODE_ROW, 'last body']);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/e2e/${title}`);

  const link = await charPoint(page.locator('#editor-root .line-row').nth(1), 'ケ', 0, 0.5);
  await page.mouse.click(link.x, link.y);
  await expect(page).toHaveURL(/\/e2e\/%E3%83%96%E3%83%A9%E3%82%B1%E3%83%86%E3%82%A3%E3%83%B3%E3%82%B0$/);
});

test('押した位置に入った caret で、IME の変換中の文字列を確定して保存できる', async ({ page }, testInfo) => {
  await loginE2eAccount(page, 'caret-e2e');
  const title = `caret-ime-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  await createE2ePage(page, title, [DECO_ROW, 'last body']);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/e2e/${title}`);

  const point = await charPoint(page.locator('#editor-root .line-row').nth(1), '強', 1, 0.25);
  await page.mouse.click(point.x, point.y);
  await expect(page.locator('#editor-root .cm-content')).toBeFocused();
  // OS の IME は再現できないので、Chromium の IME 入力（変換中の文字列と確定）を CDP で送る。
  const cdp = await page.context().newCDPSession(page);
  for (const text of ['と', 'とて', 'とても']) {
    await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
  }
  await cdp.send('Input.insertText', { text: 'とても' });
  expect((await persistedLines(page, title))[1]).toBe(' `[* 強調]` ⇒ [* とても強調]');
});
