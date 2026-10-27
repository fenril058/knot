import { test, expect, type Page } from '@playwright/test';
import { charPoint, createE2ePage, deferred, loginE2eAccount } from './helpers.ts';

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

type PageOperation = 'duplicate' | 'rename' | 'delete';

// 編集中にページ操作を始め、手元の編集の保存を待っているあいだにダイアログを閉じ、閉じた後に追記してから、
// 保留していた保存の応答を返す。閉じたページ操作は、その後に保存が終わっても server へ何も送らない（#323）。
// 返り値は、自動保存の他に送った書き込みの request（method と path）。
async function cancelWhileSaving(
  page: Page, title: string, operation: PageOperation, closeDialog: () => Promise<void>,
): Promise<string[]> {
  const autosavePath = `/api/knot/pages/e2e/${title}/commits`;
  const mutations: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET' && path !== autosavePath) mutations.push(`${request.method()} ${path}`);
  });
  // 最初の保存だけ、server の応答を受け取ったまま返さずにおく。
  const held = deferred();
  const release = deferred();
  let holding = true;
  await page.route(`**${autosavePath}`, async (route) => {
    if (!holding) return route.continue();
    holding = false;
    const response = await route.fetch();
    held.resolve();
    await release.promise;
    await route.fulfill({ response });
  });

  await typeAtLineEnd(page, 1, ' 保存待ちの編集');
  await page.locator('#page-actions > summary').click();
  await page.locator(`#${operation}-button`).click();
  if (operation !== 'delete') await page.locator(`#${operation}-title`).fill(`${title}-moved`);
  await page.locator(`#${operation}-form button[type="submit"]`).click();
  await held.promise;
  await closeDialog();
  await expect(page.locator(`#${operation}-dialog`)).toBeHidden();

  await page.locator('#editor-root .cm-line').nth(1).click();
  await page.keyboard.press('End');
  await page.keyboard.insertText(' 閉じた後の追記');
  const appendSaved = page.waitForResponse((response) =>
    new URL(response.url()).pathname === autosavePath
    && (response.request().postData() ?? '').includes('閉じた後の追記'));
  release.resolve();
  await appendSaved;
  // 閉じたページ操作の続きが動くなら、追記の保存の応答を受け取ってすぐに送る。それより十分に長く待つ。
  // 送ったページ操作が別のページへ移ることもあるので、ページの中ではなくテストの側で待つ。
  await new Promise((resolve) => {
    setTimeout(resolve, 500);
  });
  return mutations;
}

async function expectAppendKept(page: Page, title: string): Promise<void> {
  expect(await pageLines(page, title)).toEqual([title, '本文の行 保存待ちの編集 閉じた後の追記']);
  await expect(page).toHaveURL(`/e2e/${title}`);
  await expect(page.locator('#save-status')).toHaveAttribute('data-status', 'saved');
}

test('保存を待っている削除をキャンセルしたら、その後に保存が終わっても削除せず、閉じた後の追記を残す', async ({ page }, testInfo) => {
  await loginE2eAccount(page, 'page-menu-cancel-e2e');
  const title = `menu-cancel-delete-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  await createE2ePage(page, title, ['本文の行']);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/e2e/${title}`);

  const mutations = await cancelWhileSaving(page, title, 'delete', () =>
    page.locator('#delete-dialog [data-dialog-close]').click());
  expect(mutations).toEqual([]);
  await expectAppendKept(page, title);
});

test('保存を待っているリネームを Escape で閉じたら、その後に保存が終わってもリネームしない', async ({ page }, testInfo) => {
  await loginE2eAccount(page, 'page-menu-cancel-e2e');
  const title = `menu-cancel-rename-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  await createE2ePage(page, title, ['本文の行']);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/e2e/${title}`);

  const mutations = await cancelWhileSaving(page, title, 'rename', () => page.keyboard.press('Escape'));
  expect(mutations).toEqual([]);
  await expectAppendKept(page, title);
  expect(await pageLines(page, `${title}-moved`)).toBeNull();
});

test('保存を待っている複製をキャンセルしたら、その後に保存が終わっても複製しない', async ({ page }, testInfo) => {
  await loginE2eAccount(page, 'page-menu-cancel-e2e');
  const title = `menu-cancel-duplicate-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  await createE2ePage(page, title, ['本文の行']);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/e2e/${title}`);

  const mutations = await cancelWhileSaving(page, title, 'duplicate', () =>
    page.locator('#duplicate-dialog [data-dialog-close]').click());
  expect(mutations).toEqual([]);
  await expectAppendKept(page, title);
  expect(await pageLines(page, `${title}-moved`)).toBeNull();
});

test('複製元を読んでいるあいだに複製をキャンセルしたら、読み終えても複製しない', async ({ page }, testInfo) => {
  await loginE2eAccount(page, 'page-menu-cancel-e2e');
  const title = `menu-cancel-source-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  const copy = `${title}-moved`;
  await createE2ePage(page, title, ['本文の行']);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/e2e/${title}`);
  const mutations: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET') mutations.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  const held = deferred();
  const release = deferred();
  await page.route(`**/api/pages/e2e/${title}`, async (route) => {
    const response = await route.fetch();
    held.resolve();
    await release.promise;
    await route.fulfill({ response });
  });

  await page.locator('#page-actions > summary').click();
  await page.locator('#duplicate-button').click();
  await page.locator('#duplicate-title').fill(copy);
  await page.locator('#duplicate-form button[type="submit"]').click();
  await held.promise;
  await page.locator('#duplicate-dialog [data-dialog-close]').click();
  await expect(page.locator('#duplicate-dialog')).toBeHidden();
  const sourceRead = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/pages/e2e/${title}`);
  release.resolve();
  await sourceRead;
  await new Promise((resolve) => {
    setTimeout(resolve, 500);
  });
  expect(mutations).toEqual([]);
  expect(await pageLines(page, copy)).toBeNull();
  await expect(page).toHaveURL(`/e2e/${title}`);
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
