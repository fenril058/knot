import { test, expect, type Page } from '@playwright/test';
import { deferred, loginDirectEditE2e } from './helpers.ts';

// テロメアは行の左端 4px と margin 0.5rem を占める。x = 20 はそれを外した位置。
const bodyClickPosition = { x: 20, y: 8 };

async function createPage(page: Page, title: string, bodyLines: string[]): Promise<void> {
  const texts = [title, ...bodyLines];
  const ops = texts.map((text, index) => ({
    type: 'insert' as const,
    id: `${title}-line-${index}`,
    after: index === 0 ? '_head' : `${title}-line-${index - 1}`,
    text,
  }));
  const response = await page.request.post(`/api/knot/pages/e2e/${title}/commits`, {
    headers: { 'X-Knot-Client': 'e2e' },
    data: { commitId: `${title}-create`, baseVersion: 0, ops },
  });
  expect(response.ok()).toBe(true);
}

test('desktop はクリックした SSR 本文行から直接編集を開始する', async ({ page }, testInfo) => {
  await loginDirectEditE2e(page);
  const title = `direct-edit-row-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  await createPage(page, title, ['first body', 'second body']);

  await page.goto(`/e2e/${title}`);
  await expect(page.locator('#edit-page-button')).toHaveCount(0);
  const secondBody = page.locator('#editor-root .line-row').nth(2);
  await secondBody.click({ position: bodyClickPosition });

  const editor = page.locator('#editor-root .cm-content');
  await expect(editor).toBeFocused();
  await page.keyboard.press('End');
  await page.keyboard.insertText(' edited');
  await expect(page.locator('#save-status')).toHaveText('保存済み');

  const persisted = await page.request.get(`/api/pages/e2e/${title}`);
  expect(persisted.ok()).toBe(true);
  expect((await persisted.json()).lines.map((line: { text: string }) => line.text)).toEqual([
    title,
    'first body',
    'second body edited',
  ]);
});

test('本文がまだない既存ページにも直接編集の click target がある', async ({ page }, testInfo) => {
  await loginDirectEditE2e(page);
  const title = `direct-edit-empty-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  await createPage(page, title, []);

  await page.goto(`/e2e/${title}`);
  const onlyRow = page.locator('#editor-root .line-row');
  await expect(onlyRow).toHaveCount(1);
  await expect(onlyRow).toBeVisible();
  await onlyRow.click({ position: bodyClickPosition });
  await expect(page.locator('#editor-root .cm-content')).toBeFocused();
});

test('telomere click は更新情報表示だけを行い Editor を起動しない', async ({ page }, testInfo) => {
  await loginDirectEditE2e(page);
  const title = `direct-edit-telomere-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  await createPage(page, title, ['body']);

  await page.goto(`/e2e/${title}`);
  const dialogHandled = new Promise<void>((resolve) => {
    page.once('dialog', (dialog) => {
      void dialog.dismiss().then(resolve);
    });
  });
  await page.locator('#editor-root .line-row').nth(1).locator('.telomere').click();
  await dialogHandled;
  await expect(page.locator('#editor-root .cm-editor')).toHaveCount(0);

  await page.locator('#editor-root .line-row').nth(1).click({ position: bodyClickPosition });
  await expect(page.locator('#editor-root .cm-content')).toBeFocused();
});

test('SSR 本文の text selection は直接編集で破棄しない', async ({ page }, testInfo) => {
  await loginDirectEditE2e(page);
  const title = `direct-edit-selection-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  await createPage(page, title, ['selectable body']);

  await page.goto(`/e2e/${title}`);
  const bodyRow = page.locator('#editor-root .line-row').nth(1);
  await bodyRow.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });

  await expect(page.locator('#editor-root .cm-editor')).toHaveCount(0);
  expect(await page.evaluate(() => window.getSelection()?.toString())).toContain('selectable body');
});

test('starting 中の連続 click では Editor bootstrap を二重起動しない', async ({ page }, testInfo) => {
  await loginDirectEditE2e(page);
  const title = `direct-edit-starting-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  await createPage(page, title, ['body']);

  let fetchCount = 0;
  const fetchGate = deferred();
  await page.route(
    (url) => url.pathname === `/api/pages/e2e/${title}` && url.searchParams.has('pageId'),
    async (route) => {
      fetchCount += 1;
      await fetchGate.promise;
      await route.continue();
    },
  );

  await page.goto(`/e2e/${title}`);
  const row = page.locator('#editor-root .line-row').nth(1);
  await row.click({ position: bodyClickPosition });
  await row.click({ position: bodyClickPosition });

  await expect.poll(() => fetchCount).toBe(1);
  fetchGate.resolve();
  await expect(page.locator('#editor-root .cm-content')).toBeFocused();
});

test('Editor activation の fetch failure 後は SSR を保って再試行できる', async ({ page }, testInfo) => {
  await loginDirectEditE2e(page);
  const title = `direct-edit-retry-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  await createPage(page, title, ['body']);

  let fetchCount = 0;
  await page.route(
    (url) => url.pathname === `/api/pages/e2e/${title}` && url.searchParams.has('pageId'),
    async (route) => {
      fetchCount += 1;
      if (fetchCount === 1) {
        await route.fulfill({ status: 500, contentType: 'text/plain', body: 'simulated activation failure' });
        return;
      }
      await route.continue();
    },
  );

  await page.goto(`/e2e/${title}`);
  const row = page.locator('#editor-root .line-row').nth(1);
  await row.click({ position: bodyClickPosition });

  await expect(page.locator('#save-status')).toHaveText('エラー');
  await expect(row).toBeVisible();
  await expect(page.locator('#editor-root .cm-editor')).toHaveCount(0);

  await row.click({ position: bodyClickPosition });
  await expect(page.locator('#editor-root .cm-content')).toBeFocused();
  expect(fetchCount).toBe(2);
});


test('click せずキーボードだけで編集を開始し、Escape で抜けて戻れる', async ({ page }, testInfo) => {
  await loginDirectEditE2e(page);
  const title = `direct-edit-keyboard-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  await createPage(page, title, ['keyboard body']);

  await page.goto(`/e2e/${title}`);
  const editor = page.locator('#editor-root .cm-content');
  await expect(editor).toHaveCount(0);

  await page.keyboard.press('Control+e');
  await expect(editor).toBeFocused();

  // Escape が無いと、エディタに入った利用者は Tab で次の UI へ抜けられない。
  await page.keyboard.press('Escape');
  await expect(editor).not.toBeFocused();

  await page.keyboard.press('Control+e');
  await expect(editor).toBeFocused();
  await page.keyboard.press('End');
  await page.keyboard.insertText(' edited');
  await expect(page.locator('#save-status')).toHaveText('保存済み');

  const persisted = await page.request.get(`/api/pages/e2e/${title}`);
  expect((await persisted.json()).lines.map((line: { text: string }) => line.text)).toEqual([
    title,
    'keyboard body edited',
  ]);
});
