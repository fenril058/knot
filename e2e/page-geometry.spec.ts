import { test, expect, type Page } from '@playwright/test';
import {
  charPoint,
  createE2ePage,
  lineRowClickPosition,
  lineTextBoxes,
  loginE2eAccount,
  pageGeometry,
  rowHeights,
  textStyleOf,
  visualLineRects,
} from './helpers.ts';

// Cosense の既定テーマのページを Playwright で開いて測った値（#229）。
// 紙面は本文を載せる白い領域（.page）。
const LAYOUTS = [
  { viewport: { width: 1280, height: 800 }, paperX: 132, paperWidth: 960, padding: [42, 49, 42, 49], textLeft: 181 },
  { viewport: { width: 800, height: 800 }, paperX: 8, paperWidth: 728, padding: [42, 42, 35, 42], textLeft: 50 },
];
const BODY_FONT = 'Roboto, Helvetica, Arial, "Hiragino Sans", sans-serif';
const BODY = ['紙面の位置と字を Cosense に合わせる本文', '', 'last body'];

async function startEditingAtLastRow(page: Page): Promise<void> {
  await page.locator('#editor-root .line-row').nth(BODY.length).click({ position: lineRowClickPosition });
  await expect(page.locator('#editor-root .cm-content')).toBeFocused();
}

for (const layout of LAYOUTS) {
  test(`${layout.viewport.width}px では紙面と本文を Cosense と同じ位置と幅に置き、編集を始めても動かさない`, async (
    { page },
    testInfo,
  ) => {
    await loginE2eAccount(page, 'geometry-e2e');
    const title = `geometry-${layout.viewport.width}-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
    await createE2ePage(page, title, BODY);

    await page.setViewportSize(layout.viewport);
    await page.goto(`/e2e/${title}`);
    const expected = {
      bodyBackground: 'rgb(220, 221, 224)',
      bar: { height: 41, background: 'rgba(196, 197, 202, 0.7)' },
      paper: { x: layout.paperX, y: 72, width: layout.paperWidth, background: 'rgb(254, 254, 254)', padding: layout.padding },
      telomereLeft: layout.paperX,
    };
    expect(await pageGeometry(page)).toEqual(expected);
    const textLefts = (await lineTextBoxes(page)).map((box) => box.x);
    // 空行は文字を持たないので 0 になる。
    expect(textLefts).toEqual([layout.textLeft, layout.textLeft, 0, layout.textLeft]);

    await startEditingAtLastRow(page);
    // 保存状態の表示も現れているが、紙面を押し下げない。
    await expect(page.locator('#save-status')).toBeVisible();
    expect(await pageGeometry(page)).toEqual(expected);
    // Cosense は caret だけで編集中を示し、本文に枠を出さない。
    expect(await page.locator('#editor-root .cm-editor').evaluate((element) => getComputedStyle(element).outlineStyle))
      .toBe('none');
    expect((await lineTextBoxes(page)).map((box) => box.x)).toEqual(textLefts);
    const documentWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(documentWidth).toBeLessThanOrEqual(layout.viewport.width);
  });
}

test('本文とタイトルを Cosense と同じ字と行送りで描き、編集を始めても変えない', async ({ page }, testInfo) => {
  await loginE2eAccount(page, 'geometry-e2e');
  const title = `geometry-type-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  await createE2ePage(page, title, BODY);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/e2e/${title}`);
  const titleStyle = { fontFamily: BODY_FONT, fontSize: '25.95px', fontWeight: '400', lineHeight: '42px', color: 'rgb(0, 0, 0)' };
  const bodyStyle = { fontFamily: BODY_FONT, fontSize: '15px', fontWeight: '400', lineHeight: '28px', color: 'rgb(74, 74, 74)' };
  expect(await textStyleOf(page, title)).toEqual(titleStyle);
  expect(await textStyleOf(page, BODY[0]!)).toEqual(bodyStyle);
  // タイトル行は行送り 42px と下の余白 21px、空行も本文行と同じ 28px。
  expect(await rowHeights(page)).toEqual([63, 28, 28, 28]);

  await startEditingAtLastRow(page);
  expect(await textStyleOf(page, title)).toEqual(titleStyle);
  expect(await textStyleOf(page, BODY[0]!)).toEqual(bodyStyle);
  expect(await rowHeights(page)).toEqual([63, 28, 28, 28]);
});

// 本文の行の幅と高さ（#245）。1280px の本文は x=181 から幅 862px で、右端は 1043px。
const TEXT_RIGHT = 181 + 862;
const ROW_BOX_BODY = [
  'あ'.repeat(80),
  '前 `code` 後',
  `[${'い'.repeat(80)}]`,
  'last body',
];

// 行の 1 本目の視覚行の右端（最後の字の右端）。
async function firstLineRight(page: Page, rowIndex: number): Promise<number> {
  const [left, , width] = (await visualLineRects(page))[rowIndex]![0]!;
  return left! + width!;
}

test('本文の行は本文の右端まで字を並べて折り返し、インラインコードの行も 28px で、編集を始めてもカーソル行でも変えない', async (
  { page },
  testInfo,
) => {
  await loginE2eAccount(page, 'geometry-e2e');
  const title = `geometry-rows-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  await createE2ePage(page, title, ROW_BOX_BODY);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/e2e/${title}`);
  const look = async (): Promise<{ wrap: number; link: number; heights: number[] }> => ({
    wrap: await firstLineRight(page, 1),
    link: await firstLineRight(page, 3),
    heights: await rowHeights(page),
  });
  const ssr = await look();
  // 長い行は、本文の右端から全角 1 字（15px）以内まで字が並ぶ。
  expect(ssr.wrap).toBeGreaterThan(TEXT_RIGHT - 15);
  expect(ssr.wrap).toBeLessThanOrEqual(TEXT_RIGHT);
  // リンクだけの行は、行末に編集を始める面（#186）を残して折り返す。
  expect(ssr.link).toBeLessThanOrEqual(TEXT_RIGHT - 40);
  expect(ssr.link).toBeGreaterThan(TEXT_RIGHT - 40 - 15);
  expect(ssr.heights).toEqual([63, 56, 28, 56, 28]);

  await page.locator('#editor-root .line-row').nth(ROW_BOX_BODY.length).click({ position: lineRowClickPosition });
  await expect(page.locator('#editor-root .cm-content')).toBeFocused();
  expect(await look()).toEqual(ssr);

  // カーソル行（原文表示）にしても、長い行の折り返しとインラインコードの行の高さは変わらない。
  const longRow = page.locator('#editor-root .cm-line').nth(1);
  const start = await charPoint(longRow, 'あ', 0, 0.25);
  await page.mouse.click(start.x, start.y);
  await expect(longRow.locator('.cm-wysiwyg-line')).toHaveCount(0);
  expect(await firstLineRight(page, 1)).toBe(ssr.wrap);
  const codeRow = page.locator('#editor-root .cm-line').nth(2);
  const code = await charPoint(codeRow, '前', 0, 0.25);
  await page.mouse.click(code.x, code.y);
  await expect(codeRow.locator('.cm-wysiwyg-line')).toHaveCount(0);
  expect(await rowHeights(page)).toEqual(ssr.heights);
});

// 触った行の画面上の上端。閲覧表示の .line-row と CodeMirror の .cm-line を同じ数え方で測る。
async function viewportRowTop(page: Page, text: string): Promise<number> {
  return page.evaluate((expected) => {
    const rows = document.querySelectorAll('#editor-root .line-row, #editor-root .cm-line');
    const row = Array.from(rows).find((candidate) => candidate.textContent?.trim() === expected);
    if (row === undefined) throw new Error(`no row renders ${JSON.stringify(expected)}`);
    return row.getBoundingClientRect().top;
  }, text);
}

test('scroll できるページの上の方から編集を始めても、画面は 1px も動かない', async ({ page }, testInfo) => {
  await loginE2eAccount(page, 'geometry-e2e');
  const title = `geometry-scroll-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  await createE2ePage(page, title, Array.from({ length: 40 }, (_, index) => `line ${index}`));

  await page.setViewportSize({ width: 1280, height: 600 });
  await page.goto(`/e2e/${title}`);
  const before = await viewportRowTop(page, 'line 2');

  await page.locator('#editor-root .line-row').nth(3).click({ position: lineRowClickPosition });
  await expect(page.locator('#editor-root .cm-content')).toBeFocused();
  // 行送りは字より高いので、caret の矩形と行の箱を比べると、その差だけ scroll してしまう。
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect(await viewportRowTop(page, 'line 2')).toBe(before);
});

test('上部のバーにプロジェクト名を Cosense と同じ字で置き、ページ操作は紙面の右に置く', async ({ page }, testInfo) => {
  await loginE2eAccount(page, 'geometry-e2e');
  const title = `geometry-chrome-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  await createE2ePage(page, title, BODY);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/e2e/${title}`);
  const projectLink = page.locator('.page-nav-start a');
  await expect(projectLink).toHaveText('e2e');
  expect(await projectLink.evaluate((element) => {
    const style = getComputedStyle(element);
    return { color: style.color, fontSize: style.fontSize, fontWeight: style.fontWeight };
  })).toEqual({ color: 'rgb(54, 60, 73)', fontSize: '14px', fontWeight: '600' });

  // Cosense のページメニュー列は紙面の右 10px から始まり、上端は紙面と揃う。
  const menu = (await page.locator('#page-actions > summary').boundingBox())!;
  expect({ x: Math.round(menu.x), y: Math.round(menu.y) }).toEqual({ x: 132 + 960 + 10, y: 72 });
  await page.locator('#page-actions > summary').click();
  await expect(page.locator('#rename-button')).toBeInViewport();
  // メニューは紙面の上へ左に開く。紙面に重なった部分を押しても、紙面ではなくメニューに届く。
  const hits = await page.locator('.page-actions-menu button').evaluateAll((buttons) => buttons.map((button) => {
    const box = button.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + 2, box.top + box.height / 2);
    return hit !== null && button.contains(hit);
  }));
  expect(hits).toEqual([true, true, true]);
  await page.locator('#rename-button').click({ position: { x: 2, y: 8 } });
  await expect(page.locator('#rename-dialog')).toBeVisible();
  await expect(page.locator('#editor-root .cm-editor')).toHaveCount(0);
});
