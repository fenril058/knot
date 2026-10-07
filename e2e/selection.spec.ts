import { test, expect, type Page } from '@playwright/test';
import { charPoint, createE2ePage, deferred, loginE2eAccount } from './helpers.ts';

// 閲覧表示で選んだ範囲は、編集を始めても選んだままにする（#194）。Cosense と同じく、double click
// は語を、triple click は行を選ぶ。1 回目の click で編集が始まり、本文を取得している間に 2 回目
// 以降の click が届くので、取得を止めてその間に double / triple click する。

async function openWithFetchGate(page: Page, title: string, body: string[]): Promise<() => void> {
  await createE2ePage(page, title, body);
  const gate = deferred();
  await page.route(
    (url) => url.pathname === `/api/pages/e2e/${title}` && url.searchParams.has('pageId'),
    async (route) => {
      await gate.promise;
      await route.continue();
    },
  );
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/e2e/${title}`);
  return gate.resolve;
}

async function selectedText(page: Page): Promise<string | undefined> {
  return page.evaluate(() => window.getSelection()?.toString());
}

async function persistedLines(page: Page, title: string): Promise<string[]> {
  await expect(page.locator('#save-status')).toHaveText('保存済み');
  const response = await page.request.get(`/api/pages/e2e/${title}`);
  return (await response.json()).lines.map((line: { text: string }) => line.text);
}

test('閲覧表示で double click した語は、編集を始めても選んだままで、打てば置き換わる', async ({ page }, testInfo) => {
  const title = `selection-word-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  await loginE2eAccount(page, 'selection-e2e');
  const release = await openWithFetchGate(page, title, ['alpha beta gamma', 'last body']);

  const beta = await charPoint(page.locator('#editor-root .line-row').nth(1), 'beta', 0, 0.5);
  await page.mouse.dblclick(beta.x, beta.y);
  await expect.poll(() => selectedText(page)).toBe('beta');
  release();
  await expect(page.locator('#editor-root .cm-content')).toBeFocused();
  expect(await selectedText(page)).toBe('beta');

  await page.keyboard.type('X');
  expect(await persistedLines(page, title)).toEqual([title, 'alpha X gamma', 'last body']);
});

test('日本語の行の double click も、ブラウザが選んだ語を編集表示で選んだままにする', async ({ page }, testInfo) => {
  const title = `selection-japanese-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  await loginE2eAccount(page, 'selection-e2e');
  const release = await openWithFetchGate(page, title, ['クリックすると別のページに飛ぶ', '[* 太字のページ] の行']);

  // 太字の中の語も、記法の外へはみ出さずに選ぶ。
  const bold = await charPoint(page.locator('#editor-root .line-row').nth(2), 'ペ', 0, 0.5);
  await page.mouse.dblclick(bold.x, bold.y);
  await expect.poll(() => selectedText(page)).toBe('ページ');
  release();
  await expect(page.locator('#editor-root .cm-content')).toBeFocused();
  expect(await selectedText(page)).toBe('ページ');

  await page.keyboard.type('語');
  expect(await persistedLines(page, title)).toEqual([title, 'クリックすると別のページに飛ぶ', '[* 太字の語] の行']);
});

test('閲覧表示で triple click した行は、記法ごと行を選んだまま編集を始める', async ({ page }, testInfo) => {
  const title = `selection-line-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  await loginE2eAccount(page, 'selection-e2e');
  const release = await openWithFetchGate(page, title, [' [* bold word] tail', 'last body']);

  const word = await charPoint(page.locator('#editor-root .line-row').nth(1), 'word', 0, 0.5);
  await page.mouse.click(word.x, word.y, { clickCount: 3 });
  await expect.poll(() => selectedText(page)).toBe('bold word tail\n');
  release();
  await expect(page.locator('#editor-root .cm-content')).toBeFocused();
  // カーソル行は記法を出す。字下げは widget で描くので、選んだ字の並びには入らない。
  await expect.poll(() => selectedText(page)).toBe('[* bold word] tail\n');

  // CodeMirror の triple click と同じく、字下げと記法を含む行と、その後ろの改行を選んでいる。
  await page.keyboard.type('X');
  expect(await persistedLines(page, title)).toEqual([title, 'Xlast body']);
});

test('最後の行の triple click は、本文の後ろまで及んでも、その行の終わりまでを選んだまま編集を始める', async (
  { page },
  testInfo,
) => {
  const title = `selection-last-line-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  // 本文の後ろに関連ページが並ぶと、最後の行の triple click はそこまで及ぶ。
  const linked = `${title}-linked`;
  await loginE2eAccount(page, 'selection-e2e');
  await createE2ePage(page, linked, ['linked body']);
  const release = await openWithFetchGate(page, title, [`first [${linked}] body`, 'last body']);

  const body = await charPoint(page.locator('#editor-root .line-row').nth(2), 'body', 0, 0.5);
  await page.mouse.click(body.x, body.y, { clickCount: 3 });
  await expect.poll(() => selectedText(page)).toMatch(/^last body\n/);
  release();
  await expect(page.locator('#editor-root .cm-content')).toBeFocused();
  expect(await selectedText(page)).toBe('last body');

  await page.keyboard.type('X');
  expect(await persistedLines(page, title)).toEqual([title, `first [${linked}] body`, 'X']);
});
