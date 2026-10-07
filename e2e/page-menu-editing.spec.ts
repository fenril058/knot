import { test, expect, type Page } from '@playwright/test';
import { charPoint, createE2ePage, loginE2eAccount } from './helpers.ts';

// 編集を始めてもページメニューを出したままにし、編集中のページ操作は手元の編集を保存し終えてから
// 行う（#192）。

async function pageLines(page: Page, title: string): Promise<string[] | null> {
  const response = await page.request.get(`/api/pages/e2e/${encodeURIComponent(title)}`);
  if (!response.ok()) return null;
  return (await response.json()).lines.map((line: { text: string }) => line.text);
}

// 本文の行を押して編集を始め、行末に text を打つ。自動保存（500ms 後）を待たずに戻る。
async function typeAtLineEnd(page: Page, rowIndex: number, text: string): Promise<void> {
  const row = page.locator('#editor-root .line-row').nth(rowIndex);
  const point = await charPoint(row, '本', 0, 0.25);
  await page.mouse.click(point.x, point.y);
  await expect(page.locator('#editor-root .cm-content')).toBeFocused();
  await page.keyboard.press('End');
  await page.keyboard.insertText(text);
}

async function recoveryKeys(page: Page): Promise<string[]> {
  return page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('knot:pending:')));
}

test('編集を始めても、ページメニューは閲覧表示と同じ位置に出たまま', async ({ page }, testInfo) => {
  await loginE2eAccount(page, 'page-menu-e2e');
  const title = `menu-visible-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  await createE2ePage(page, title, ['本文の行']);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/e2e/${title}`);
  const before = await page.locator('.page-actions > summary').evaluateAll((summaries) =>
    summaries.map((summary) => summary.getBoundingClientRect().toJSON()));

  await typeAtLineEnd(page, 1, '');
  const after = await page.locator('.page-actions > summary').evaluateAll((summaries) =>
    summaries.map((summary) => summary.getBoundingClientRect().toJSON()));
  expect(after).toEqual(before);
  await expect(page.locator('#page-actions > summary')).toBeVisible();
});

test('編集中にリネームすると、手元の編集を保存してから新しいタイトルへ移る', async ({ page }, testInfo) => {
  await loginE2eAccount(page, 'page-menu-e2e');
  const suffix = `${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  const title = `menu-rename-${suffix}`;
  const renamed = `menu-renamed-${suffix}`;
  await createE2ePage(page, title, ['本文の行']);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/e2e/${title}`);

  await typeAtLineEnd(page, 1, ' 手元の編集');
  await page.locator('#page-actions > summary').click();
  await page.locator('#rename-button').click();
  await page.locator('#rename-title').fill(renamed);
  await page.locator('#rename-form button[type="submit"]').click();
  await expect(page).toHaveURL(`/e2e/${renamed}`);
  expect(await pageLines(page, renamed)).toEqual([renamed, '本文の行 手元の編集']);
});

test('編集中に削除すると、手元の編集を保存してから削除し、回復記録を残さない', async ({ page }, testInfo) => {
  await loginE2eAccount(page, 'page-menu-e2e');
  const title = `menu-delete-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  await createE2ePage(page, title, ['本文の行']);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/e2e/${title}`);

  await typeAtLineEnd(page, 1, ' 消えるページの編集');
  await page.locator('#page-actions > summary').click();
  await page.locator('#delete-button').click();
  await page.locator('#delete-form button[type="submit"]').click();
  await expect(page).toHaveURL('/e2e');
  expect(await pageLines(page, title)).toBeNull();
  expect(await recoveryKeys(page)).toEqual([]);
});

test('編集中に複製すると、手元の編集を含めて複製する', async ({ page }, testInfo) => {
  await loginE2eAccount(page, 'page-menu-e2e');
  const suffix = `${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  const title = `menu-duplicate-${suffix}`;
  const copy = `menu-copy-${suffix}`;
  await createE2ePage(page, title, ['本文の行']);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/e2e/${title}`);

  await typeAtLineEnd(page, 1, ' 複製に入る編集');
  await page.locator('#page-actions > summary').click();
  await page.locator('#duplicate-button').click();
  await page.locator('#duplicate-title').fill(copy);
  await page.locator('#duplicate-form button[type="submit"]').click();
  await expect(page).toHaveURL(`/e2e/${copy}`);
  expect(await pageLines(page, copy)).toEqual([copy, '本文の行 複製に入る編集']);
});

test('保存できない編集が残っているときは、ページ操作をせずに理由を出す', async ({ page }, testInfo) => {
  await loginE2eAccount(page, 'page-menu-e2e');
  const suffix = `${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  const title = `menu-unsaved-${suffix}`;
  await createE2ePage(page, title, ['本文の行']);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/e2e/${title}`);

  // 保存の送信を通信の失敗にする。
  await page.route(`**/api/knot/pages/e2e/${title}/commits`, (route) => route.abort());
  await typeAtLineEnd(page, 1, ' 保存できない編集');
  await expect(page.locator('#save-status')).toHaveAttribute('data-status', 'error');
  await page.locator('#page-actions > summary').click();
  await page.locator('#rename-button').click();
  await page.locator('#rename-title').fill(`menu-not-renamed-${suffix}`);
  await page.locator('#rename-form button[type="submit"]').click();
  await expect(page.locator('#rename-error')).toHaveText('手元に保存できていない編集があります。保存し終えてから、もう一度操作してください');
  await expect(page).toHaveURL(`/e2e/${title}`);
  expect(await pageLines(page, title)).toEqual([title, '本文の行']);
});
