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

test('日本語の行の double click も、選んだ語を編集表示で選んだままにする', async ({ page }, testInfo) => {
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
  // カーソル行は記法と、字下げの空白を字のまま見せる（#271）。
  await expect.poll(() => selectedText(page)).toBe(' [* bold word] tail\n');

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

// double click で選ぶ語は、Cosense と同じく同じ種類の字が続く範囲にする（#261）。漢字・ひらがな・
// カタカナ・英数字を別の語として扱う。字の右半分を押すと、caret の後ろの字（次の字）の語を選ぶ。
const MIXED_ROW = 'agent-skillsからsubagent-consultationを追加、sanity-reviewの更新を取り込み (#8313)';

async function doubleClickAt(page: Page, row: number, text: string, fraction: number): Promise<void> {
  const point = await charPoint(page.locator('#editor-root .cm-line').nth(row), text, 0, fraction);
  await page.mouse.dblclick(point.x, point.y);
}

test('編集表示の double click は、Cosense と同じく漢字・かな・英数字の続く範囲を語として選ぶ', async ({ page }, testInfo) => {
  await loginE2eAccount(page, 'selection-e2e');
  const title = `selection-cm-word-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  await createE2ePage(page, title, [MIXED_ROW, 'package-lock.json と 4.7.1', 'last body']);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/e2e/${title}`);
  await page.locator('#editor-root .line-row').nth(3).click({ position: { x: 60, y: 8 } });
  await expect(page.locator('#editor-root .cm-content')).toBeFocused();

  const cases: Array<[number, string, number, string]> = [
    [1, '込', 0.3, '込'],
    [1, '加', 0.3, '追加'],
    // 字の右半分を押すと、Cosense と同じく次の字（、）の語になる。
    [1, '加', 0.8, '、'],
    [1, 'consultation', 0.3, 'consultation'],
    [1, '(#', 0.2, '(#'],
    [2, 'lock', 0.3, 'lock'],
    [2, '7', 0.3, '7'],
  ];
  for (const [row, text, fraction, expected] of cases) {
    await doubleClickAt(page, row, text, fraction);
    expect(await selectedText(page), `${text} @ ${fraction}`).toBe(expected);
  }

  // double click から押したまま動かすと、語の単位で広げる。
  const start = await charPoint(page.locator('#editor-root .cm-line').nth(1), '追', 0, 0.3);
  const end = await charPoint(page.locator('#editor-root .cm-line').nth(1), '更', 0, 0.3);
  await page.mouse.click(start.x, start.y);
  await page.mouse.down({ clickCount: 2 });
  await page.mouse.move(end.x, end.y, { steps: 4 });
  await page.mouse.up({ clickCount: 2 });
  expect(await selectedText(page)).toBe('追加、sanity-reviewの更新');
});

test('閲覧表示の double click も、編集表示と同じ区切りの語を選んだまま編集を始める', async ({ page }, testInfo) => {
  await loginE2eAccount(page, 'selection-e2e');
  const title = `selection-read-word-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  const release = await openWithFetchGate(page, title, [MIXED_ROW, 'last body']);

  // ブラウザ（ICU）の区切りでは「取り込み」が 1 語になる。
  const point = await charPoint(page.locator('#editor-root .line-row').nth(1), '込', 0, 0.3);
  await page.mouse.dblclick(point.x, point.y);
  await expect.poll(() => selectedText(page)).toBe('込');
  release();
  await expect(page.locator('#editor-root .cm-content')).toBeFocused();
  expect(await selectedText(page)).toBe('込');

  await page.keyboard.type('X');
  expect(await persistedLines(page, title)).toEqual([title, MIXED_ROW.replace('取り込み', '取りXみ'), 'last body']);
});
