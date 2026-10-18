import { test, expect, type Page } from '@playwright/test';
import { createE2ePage, lineRowClickPosition, loginE2eAccount } from './helpers.ts';

// Cosense の上部のバー（.navbar）は position: fixed で、scroll しても画面の上に残る（#303）。
// バーが本文の上に重なるので、caret の行や focus を移した要素がバーの下に隠れたままにならないことも確かめる。
const LONG_BODY = Array.from({ length: 40 }, (_, index) => `line ${index}`);

type VerticalBox = { top: number; bottom: number };

// バーの下端の画面上の位置。バーが scroll で画面の外へ出ていれば負になる。
async function barBottom(page: Page): Promise<number> {
  return page.locator('.page-nav').evaluate((element) => element.getBoundingClientRect().bottom);
}

// 本文の行の箱。閲覧表示の行と編集表示の行のどちらでも、行の字で探す。
async function rowBox(page: Page, text: string): Promise<VerticalBox> {
  return page.evaluate((expected) => {
    const rows = document.querySelectorAll('#editor-root .line-row, #editor-root .cm-line');
    const row = Array.from(rows).find((candidate) => candidate.textContent?.trim() === expected);
    if (row === undefined) throw new Error(`the row is not rendered: ${expected}`);
    const { top, bottom } = row.getBoundingClientRect();
    return { top, bottom };
  }, text);
}

// 行の上端が画面の上端から top の位置に来るまで scroll する。
async function scrollRowTo(page: Page, text: string, top: number): Promise<void> {
  const current = (await rowBox(page, text)).top;
  await page.evaluate((delta) => window.scrollBy(0, delta), current - top);
}

// caret の矩形と、caret のある行の字。
async function caret(page: Page): Promise<VerticalBox & { line: string | null }> {
  return page.evaluate(() => {
    const selection = document.getSelection();
    if (selection === null || selection.rangeCount === 0) throw new Error('the selection is missing');
    const range = selection.getRangeAt(0);
    const { top, bottom } = range.getBoundingClientRect();
    const node = range.startContainer;
    const line = (node instanceof Element ? node : node.parentElement)?.closest('.cm-line');
    return { top, bottom, line: line?.textContent ?? null };
  });
}

test('scroll しても、上部のバーは Cosense と同じく画面の上に残り、ページメニューの列はバーの 4px 下で止まる', async ({ page }, testInfo) => {
  await loginE2eAccount(page, 'bar-e2e');
  const title = `bar-scroll-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  await createE2ePage(page, title, LONG_BODY);

  await page.setViewportSize({ width: 1280, height: 600 });
  await page.goto(`/e2e/${title}`);
  const menuTop = async (): Promise<number> => (await page.locator('#page-info > summary').boundingBox())!.y;
  // scroll していないときの紙面とページメニューの位置（上端 72px）は変えない。
  expect((await page.locator('.page').boundingBox())!.y).toBe(72);
  expect(await menuTop()).toBe(72);

  await page.evaluate(() => window.scrollTo(0, 600));
  expect(await page.evaluate(() => window.scrollY)).toBe(600);
  const bar = page.locator('.page-nav');
  expect(await bar.boundingBox()).toEqual({ x: 0, y: 0, width: 1280, height: 41 });
  // 下を流れる紙面は、Cosense と同じくぼけて透ける。
  await expect(bar).toHaveCSS('backdrop-filter', 'blur(10px)');
  expect(await menuTop()).toBe(41 + 4);
  // バーは紙面の上に重なる。検索欄の上を押せば、紙面ではなく検索欄に届く。
  const input = page.locator('.nav-search-input');
  expect(await input.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === element;
  })).toBe(true);
  await input.fill(title);
  await expect(page.locator('.nav-search-candidates a', { hasText: title })).toBeVisible();
  expect(await page.evaluate(() => window.scrollY)).toBe(600);
});

test('編集表示で caret を上の行へ動かしても、caret は上部のバーの下に隠れない', async ({ page }, testInfo) => {
  await loginE2eAccount(page, 'bar-e2e');
  const title = `bar-caret-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  await createE2ePage(page, title, LONG_BODY);

  await page.setViewportSize({ width: 1280, height: 600 });
  await page.goto(`/e2e/${title}`);
  await page.locator('#editor-root .line-row').nth(21).click({ position: lineRowClickPosition });
  await expect(page.locator('#editor-root .cm-content')).toBeFocused();
  await page.keyboard.press('End');
  // caret の行（line 20）をバーのすぐ下に置くと、1 つ上の行（line 19）はバーの下に入る。
  await scrollRowTo(page, 'line 20', 50);
  expect((await rowBox(page, 'line 19')).top).toBeLessThan(await barBottom(page));

  await page.keyboard.press('ArrowUp');
  await expect.poll(async () => (await caret(page)).line).toBe('line 19');
  await expect.poll(async () => (await caret(page)).top - await barBottom(page)).toBeGreaterThanOrEqual(0);
});

test('キーボードでテロメアの focus を上の行へ移しても、そのテロメアは上部のバーの下に隠れない', async ({ page }, testInfo) => {
  await loginE2eAccount(page, 'bar-e2e');
  const title = `bar-focus-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  await createE2ePage(page, title, LONG_BODY);

  await page.setViewportSize({ width: 1280, height: 600 });
  await page.goto(`/e2e/${title}`);
  const telomere = (index: number) => page.locator('#editor-root .line-row').nth(index).locator('> .telomere');
  await telomere(21).focus();
  await scrollRowTo(page, 'line 20', 50);
  expect((await rowBox(page, 'line 19')).top).toBeLessThan(await barBottom(page));

  await page.keyboard.press('ArrowUp');
  await expect(telomere(20)).toBeFocused();
  const focused = await telomere(20).evaluate((element) => element.getBoundingClientRect().top);
  expect(focused - await barBottom(page)).toBeGreaterThanOrEqual(0);
});

test('200px を超えて scroll したら、Cosense と同じく画面の左下にページのタイトルを出す', async ({ page }, testInfo) => {
  await loginE2eAccount(page, 'bar-e2e');
  // 250px に収まらない長さのタイトル。
  const title = `bar-status-${testInfo.workerIndex}-${testInfo.repeatEachIndex}-${'long-title-'.repeat(6)}`;
  await createE2ePage(page, title, LONG_BODY);

  await page.setViewportSize({ width: 1280, height: 600 });
  await page.goto(`/e2e/${title}`);
  const status = page.locator('.status-page-title');
  await expect(status).toBeHidden();
  // Cosense は 200px では出さず、201px で出す（#307）。
  await page.evaluate(() => window.scrollTo(0, 200));
  await expect(status).toBeHidden();
  await page.evaluate(() => window.scrollTo(0, 201));
  await expect(status).toBeVisible();
  await expect(status).toHaveText(title);
  expect(await status.evaluate((element) => {
    const style = getComputedStyle(element);
    const { x, y, width, height } = element.getBoundingClientRect();
    return {
      box: { x, y, width, height },
      truncated: element.scrollWidth > element.clientWidth,
      font: `${style.fontSize}/${style.lineHeight}`,
      color: style.color,
      background: style.backgroundColor,
      padding: style.padding,
      radius: style.borderRadius,
    };
  })).toEqual({
    box: { x: 0, y: 600 - 20, width: 250, height: 20 },
    truncated: true,
    font: '12px/20px',
    color: 'rgb(102, 104, 116)',
    background: 'rgb(220, 221, 224)',
    padding: '0px 2px 0px 5px',
    radius: '0px 3px 0px 0px',
  });
  // タイトルの上を押しても、下の本文に届く。
  expect(await status.evaluate((element) => {
    const { x, y, width, height } = element.getBoundingClientRect();
    const hit = document.elementFromPoint(x + width / 2, y + height / 2);
    return hit !== null && !element.contains(hit);
  })).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(status).toBeHidden();
});

test('ショートカットで編集を始めるとき、最終行が上部のバーの下に入っていれば、caret をバーの下へ出す', async ({ page }, testInfo) => {
  await loginE2eAccount(page, 'bar-e2e');
  const suffix = `${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  const linked = `bar-linked-${suffix}`;
  const title = `bar-shortcut-${suffix}`;
  await createE2ePage(page, linked, ['linked body']);
  // リンク先のページがあると、本文の下に関連ページの札が並ぶので、最終行をバーの下まで scroll できる。
  await createE2ePage(page, title, [`[${linked}]`, ...LONG_BODY.slice(0, 10), 'last body']);

  await page.setViewportSize({ width: 1280, height: 300 });
  await page.goto(`/e2e/${title}`);
  await scrollRowTo(page, 'last body', 10);
  expect((await rowBox(page, 'last body')).bottom).toBeLessThanOrEqual(await barBottom(page));

  // ADR 0018 どおり最終行から始まる。最終行はバーに隠れていて見えないので、caret のほうを画面へ入れる。
  await page.keyboard.press('Control+e');
  await expect(page.locator('#editor-root .cm-content')).toBeFocused();
  await expect.poll(async () => (await caret(page)).line).toBe('last body');
  await expect.poll(async () => (await caret(page)).top - await barBottom(page)).toBeGreaterThanOrEqual(0);
});
