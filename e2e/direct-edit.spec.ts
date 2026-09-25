import { test, expect } from '@playwright/test';
import {
  createE2ePage as createPage,
  expectSameTextBox,
  deferred,
  lineRowClickPosition,
  lineTextBoxes,
  loginDirectEditE2e,
  loginE2eAccount,
  loginTitleE2e,
  textStyleOf,
  visibleTitleCount,
} from './helpers.ts';

test('desktop はクリックした SSR 本文行から直接編集を開始する', async ({ page }, testInfo) => {
  await loginDirectEditE2e(page);
  const title = `direct-edit-row-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  await createPage(page, title, ['first body', 'second body']);

  await page.goto(`/e2e/${title}`);
  await expect(page.locator('#edit-page-button')).toHaveCount(0);
  const secondBody = page.locator('#editor-root .line-row').nth(2);
  await secondBody.click({ position: lineRowClickPosition });

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

test('desktop は見えているタイトルの click から title 行を編集して rename できる', async ({ page }, testInfo) => {
  await loginTitleE2e(page);
  const title = `direct-edit-title-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  const renamed = `${title}-renamed`;
  await createPage(page, title, ['title body']);

  await page.goto(`/e2e/${title}`);
  const heading = page.getByRole('heading', { level: 1 });
  await expect(heading).toHaveText(title);
  expect(await visibleTitleCount(page, title)).toBe(1);
  const pageId = await page.locator('#editor-root').getAttribute('data-page-id');
  expect(pageId).toBeTruthy();

  await heading.click();
  await expect(page.locator('#editor-root .cm-content')).toBeFocused();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);
  await expect(page.locator('#editor-root .cm-line').first()).toHaveText(title);
  expect(await visibleTitleCount(page, title)).toBe(1);

  await page.keyboard.press('End');
  await page.keyboard.insertText('-renamed');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(renamed);
  await expect(page.locator('#save-status')).toHaveText('保存済み');
  await expect(page).toHaveURL(`/e2e/${renamed}`);

  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(renamed);
  await expect(page.locator('#editor-root')).toHaveAttribute('data-page-id', pageId!);
  expect(await visibleTitleCount(page, renamed)).toBe(1);
  await expect(page.locator('#editor-root .line-row')).toHaveText([renamed, 'title body']);
});

test('本文行から編集を開始してもタイトルは 1 つのまま', async ({ page }, testInfo) => {
  await loginTitleE2e(page);
  const title = `direct-edit-title-body-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  await createPage(page, title, ['body']);

  await page.goto(`/e2e/${title}`);
  expect(await visibleTitleCount(page, title)).toBe(1);

  await page.locator('#editor-root .line-row').nth(1).click({ position: lineRowClickPosition });
  await expect(page.locator('#editor-root .cm-content')).toBeFocused();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);
  await expect(page.locator('#editor-root .cm-line').nth(1)).toContainText('body');
  expect(await visibleTitleCount(page, title)).toBe(1);
});

test('JavaScript 無効でもタイトルは見出しとして 1 つだけ残る', async ({ browser }, testInfo) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const noScriptPage = await context.newPage();
  try {
    await loginTitleE2e(noScriptPage);
    const title = `direct-edit-title-noscript-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
    await createPage(noScriptPage, title, ['body']);

    await noScriptPage.goto(`/e2e/${title}`);
    const heading = noScriptPage.getByRole('heading', { level: 1 });
    await expect(heading).toHaveCount(1);
    await expect(heading).toHaveText(title);
    // 見出しは本文の先頭行そのもので、本文の外に重複して出ない。
    await expect(noScriptPage.locator('main > h1')).toHaveCount(0);
    await expect(noScriptPage.locator('#editor-root .line-row')).toHaveText([title, 'body']);
  } finally {
    await context.close();
  }
});

test('本文がまだない既存ページにも直接編集の click target がある', async ({ page }, testInfo) => {
  await loginDirectEditE2e(page);
  const title = `direct-edit-empty-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  await createPage(page, title, []);

  await page.goto(`/e2e/${title}`);
  const onlyRow = page.locator('#editor-root .line-row');
  await expect(onlyRow).toHaveCount(1);
  await expect(onlyRow).toBeVisible();
  await onlyRow.click({ position: lineRowClickPosition });
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

  await page.locator('#editor-root .line-row').nth(1).click({ position: lineRowClickPosition });
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
  await row.click({ position: lineRowClickPosition });
  await row.click({ position: lineRowClickPosition });

  await expect.poll(() => fetchCount).toBe(1);
  fetchGate.resolve();
  await expect(page.locator('#editor-root .cm-content')).toBeFocused();
});

test('編集開始の fetch failure 後は SSR を保って再試行できる', async ({ page }, testInfo) => {
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
  await row.click({ position: lineRowClickPosition });

  await expect(page.locator('#save-status')).toHaveText('エラー');
  await expect(row).toBeVisible();
  await expect(page.locator('#editor-root .cm-editor')).toHaveCount(0);

  await row.click({ position: lineRowClickPosition });
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

  // ADR 0018 どおり最終行から始まるので、タイトル行は変わらず URL も動かない。
  await expect(page).toHaveURL(`/e2e/${title}`);
  const persisted = await page.request.get(`/api/pages/e2e/${title}`);
  expect((await persisted.json()).lines.map((line: { text: string }) => line.text)).toEqual([
    title,
    'keyboard body edited',
  ]);
});

test('編集開始の前に行が増えても、click した行の内容に caret が入る', async ({ page }, testInfo) => {
  await loginDirectEditE2e(page);
  const title = `direct-edit-stable-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  await createPage(page, title, ['alpha', 'beta']);

  await page.goto(`/e2e/${title}`);
  // SSR 表示のあと、click した行より前にサーバ側で 1 行増やす。DOM の index を使うと alpha に落ちる。
  const inserted = await page.request.post(`/api/knot/pages/e2e/${title}/commits`, {
    headers: { 'X-Knot-Client': 'e2e' },
    data: {
      commitId: `${title}-insert`,
      baseVersion: 1,
      ops: [{ type: 'insert', id: `${title}-line-inserted`, after: `${title}-line-0`, text: 'inserted' }],
    },
  });
  expect(inserted.ok()).toBe(true);

  await page.locator('#editor-root .line-row').nth(2).click({ position: lineRowClickPosition });
  await expect(page.locator('#editor-root .cm-content')).toBeFocused();
  await page.keyboard.press('End');
  await page.keyboard.insertText('!!');
  await expect(page.locator('#save-status')).toHaveText('保存済み');

  const persisted = await page.request.get(`/api/pages/e2e/${title}`);
  expect((await persisted.json()).lines.map((line: { text: string }) => line.text)).toEqual([
    title,
    'inserted',
    'alpha',
    'beta!!',
  ]);
});

test('操作ダイアログを開いたままのショートカットでは編集を開始しない', async ({ page }, testInfo) => {
  await loginDirectEditE2e(page);
  const title = `direct-edit-dialog-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  await createPage(page, title, ['body']);

  await page.goto(`/e2e/${title}`);
  await page.locator('#page-actions summary').click();
  await page.locator('#rename-button').click();
  const dialog = page.locator('#rename-dialog');
  await expect(dialog).toBeVisible();

  await page.locator('#rename-dialog [data-dialog-close]').focus();
  await page.keyboard.press('Control+e');
  // 起動は fetch を挟む非同期なので、起きないことを主張する前に完了しうる時間を与える。
  await page.waitForTimeout(1500);

  // 起動すると #page-menu-root ごと hidden になり、modal が open のまま画面から消えて文書が inert になる。
  await expect(dialog).toBeVisible();
  await expect(page.locator('#editor-root .cm-content')).toHaveCount(0);
});

test('SSR 本文のリンク click は navigation のままで、編集を開始しない', async ({ page }, testInfo) => {
  await loginDirectEditE2e(page);
  const suffix = `${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  const target = `direct-edit-link-target-${suffix}`;
  const title = `direct-edit-link-${suffix}`;
  await createPage(page, target, ['target body']);
  await createPage(page, title, [`[${target}]`]);

  // 起動すると必ずこの fetch が出る。navigation で中断されても記録は残るので、
  // 「起動しなかった」を遷移後にも観測できる。
  let activationFetchCount = 0;
  await page.route(
    (url) => url.pathname === `/api/pages/e2e/${title}` && url.searchParams.has('pageId'),
    async (route) => {
      activationFetchCount += 1;
      await route.continue();
    },
  );

  await page.goto(`/e2e/${title}`);
  const link = page.locator('#editor-root .line-row').nth(1).locator('a');
  await expect(link).toHaveAttribute('href', `/e2e/${target}`);
  await link.click();

  await expect(page).toHaveURL(new RegExp(`/e2e/${target}$`));
  await expect(page.locator('.page-body')).toContainText('target body');
  expect(activationFetchCount).toBe(0);
});

// viewport 1280px の閲覧表示で確実に 2 行以上へ折り返す長さ。
const LONG_BODY_LINE = '長い行が編集中も折り返すことを確かめるための本文です。'.repeat(5);

test('編集を開始しても長い行は折り返したまま横スクロールにならない', async ({ page }, testInfo) => {
  await loginE2eAccount(page, 'wrap-e2e');
  const title = `editor-wrap-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  await createPage(page, title, [LONG_BODY_LINE, 'short body']);

  await page.goto(`/e2e/${title}`);
  const ssrHeights = await page.locator('#editor-root .line-row').evaluateAll((rows) =>
    rows.map((row) => row.getBoundingClientRect().height)
  );
  // 閲覧時は通常の block として折り返っている。この比較の基準になる。
  expect(ssrHeights[1]!).toBeGreaterThan(ssrHeights[2]! * 1.5);

  await page.locator('#editor-root .line-row').nth(2).click({ position: lineRowClickPosition });
  await expect(page.locator('#editor-root .cm-content')).toBeFocused();

  const scroller = await page.locator('#editor-root .cm-scroller').evaluate((element) => ({
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
  }));
  expect(scroller.scrollWidth).toBeLessThanOrEqual(scroller.clientWidth);

  const editorHeights = await page.locator('#editor-root .cm-line').evaluateAll((lines) =>
    lines.map((line) => line.getBoundingClientRect().height)
  );
  // 非 active の整形表示行も折り返す。基準は active 行（short body）1 行ぶんの高さ。
  expect(editorHeights[1]!).toBeGreaterThan(editorHeights[2]! * 1.5);

  // 折り返した行を編集して保存できる。
  // 折り返した行の中央は視覚行の外に落ちうるので、locator の中央 click ではなく
  // 1 本目の視覚行の先頭を座標で押して、caret の位置を決める。
  const longLine = page.locator('#editor-root .cm-line').nth(1);
  const longLineBox = (await longLine.boundingBox())!;
  await page.mouse.click(longLineBox.x + 2, longLineBox.y + 4);
  await expect(longLine).toHaveText(LONG_BODY_LINE);

  // 原文表示に切り替わった行そのものも折り返す。整形表示のときだけ折り返して
  // raw では横スクロールへ戻る、という状態にならないことを直接固定する。
  const raw = await page.evaluate(() => {
    const rawScroller = document.querySelector('#editor-root .cm-scroller');
    const lines = Array.from(document.querySelectorAll('#editor-root .cm-line'));
    if (rawScroller === null) throw new Error('editor scroller is missing');
    return {
      scrollWidth: rawScroller.scrollWidth,
      clientWidth: rawScroller.clientWidth,
      activeHeight: lines[1]!.getBoundingClientRect().height,
      shortHeight: lines[2]!.getBoundingClientRect().height,
    };
  });
  expect(raw.scrollWidth).toBeLessThanOrEqual(raw.clientWidth);
  expect(raw.activeHeight).toBeGreaterThan(raw.shortHeight * 1.5);

  await page.keyboard.insertText('!');
  await expect(page.locator('#save-status')).toHaveText('保存済み');

  const persisted = await page.request.get(`/api/pages/e2e/${title}`);
  expect(persisted.ok()).toBe(true);
  expect((await persisted.json()).lines.map((line: { text: string }) => line.text)).toEqual([
    title,
    `!${LONG_BODY_LINE}`,
    'short body',
  ]);
});

test('分割できない長い行も、原文表示のまま折り返す', async ({ page }, testInfo) => {
  await loginE2eAccount(page, 'wrap-e2e');
  const title = `editor-wrap-unbreakable-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  const unbreakable = `https://example.com/${'x'.repeat(400)}`;
  await createPage(page, title, [unbreakable, 'short body']);

  await page.goto(`/e2e/${title}`);
  await page.locator('#editor-root .line-row').nth(2).click({ position: lineRowClickPosition });
  await expect(page.locator('#editor-root .cm-content')).toBeFocused();

  // 分割できる位置を持たない行を原文表示へ切り替える。
  const target = page.locator('#editor-root .cm-line').nth(1);
  const box = (await target.boundingBox())!;
  await page.mouse.click(box.x + 2, box.y + 4);
  await expect(target).toHaveText(unbreakable);

  const layout = await page.evaluate(() => {
    const scroller = document.querySelector('#editor-root .cm-scroller');
    const lines = Array.from(document.querySelectorAll('#editor-root .cm-line'));
    if (scroller === null) throw new Error('editor scroller is missing');
    return {
      scrollWidth: scroller.scrollWidth,
      clientWidth: scroller.clientWidth,
      activeHeight: lines[1]!.getBoundingClientRect().height,
      shortHeight: lines[2]!.getBoundingClientRect().height,
    };
  });
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);
  expect(layout.activeHeight).toBeGreaterThan(layout.shortHeight * 1.5);
});

test('折り返さない code 行があっても他の行の折り返しは止まらない', async ({ page }, testInfo) => {
  await loginE2eAccount(page, 'wrap-e2e');
  const title = `editor-wrap-code-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  await createPage(page, title, [
    LONG_BODY_LINE,
    'code:sample.txt',
    ` ${'x'.repeat(400)}`,
    'short body',
  ]);

  await page.goto(`/e2e/${title}`);
  await page.locator('#editor-root .line-row').nth(4).click({ position: lineRowClickPosition });
  await expect(page.locator('#editor-root .cm-content')).toBeFocused();

  // code 行は閲覧表示でも折り返さない（.code-line は white-space: pre）。
  // そのはみ出しがその行だけに収まり、他の行の折り返しを止めないことを見る。
  const layout = await page.evaluate(() => {
    const scroller = document.querySelector('#editor-root .cm-scroller');
    if (scroller === null) throw new Error('editor scroller is missing');
    return {
      clientWidth: scroller.clientWidth,
      lineWidths: Array.from(
        document.querySelectorAll('#editor-root .cm-line'),
        (line) => Math.round(line.getBoundingClientRect().width),
      ),
      lineHeights: Array.from(
        document.querySelectorAll('#editor-root .cm-line'),
        (line) => line.getBoundingClientRect().height,
      ),
    };
  });
  for (const width of layout.lineWidths) expect(width).toBeLessThanOrEqual(layout.clientWidth);
  expect(layout.lineHeights[1]!).toBeGreaterThan(layout.lineHeights[4]! * 1.5);
});

// 閲覧表示で 2 行以上に折り返る長さ。折り返し位置まで一致することを見るために使う。
const PARITY_LONG_LINE = '編集開始の前後で字と位置が変わらないことを確かめる本文です。'.repeat(4);
// 分割できる位置を持たない長いラベル。閲覧表示でページを横にはみ出させる。
const UNBREAKABLE_LINK = '[https://example.com/a/very/long/unbreakable/path/segment/that/never/wraps/at/all]';

// 引用行は閲覧表示が blockquote、編集表示が q で、要素そのものが違う。
// この PR の対象外で、#188 の残りとして #201 で扱う。
const PARITY_BODY = [
  PARITY_LONG_LINE,
  '  indented body',
  '[* bold] and #hashtag',
  'spaced    gap   here',
  'table:sample',
  ' left	right',
  'short body',
];

test('編集開始の前後で本文の字と位置が変わらない', async ({ page }, testInfo) => {
  await loginE2eAccount(page, 'parity-e2e');
  const title = `editor-parity-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  await createPage(page, title, PARITY_BODY);

  await page.goto(`/e2e/${title}`);
  const beforeTitleStyle = await textStyleOf(page, title);
  const beforeBodyStyle = await textStyleOf(page, PARITY_LONG_LINE);
  const beforeBoxes = await lineTextBoxes(page);
  // 文字を持たない行があると lineTextBoxes が 0 を返し、一致の assertion が素通りする。
  for (const box of beforeBoxes) expect(box.width).toBeGreaterThan(0);

  // 最終行から起動する。active 行は原文表示になるので、比較対象の行は非 active のままにする。
  await page.locator('#editor-root .line-row').nth(PARITY_BODY.length).click({ position: lineRowClickPosition });
  await expect(page.locator('#editor-root .cm-content')).toBeFocused();

  expect(await textStyleOf(page, title)).toEqual(beforeTitleStyle);
  expect(await textStyleOf(page, PARITY_LONG_LINE)).toEqual(beforeBodyStyle);
  const afterBoxes = await lineTextBoxes(page);
  expect(afterBoxes).toHaveLength(beforeBoxes.length);
  for (const [index, before] of beforeBoxes.entries()) expectSameTextBox(index, before, afterBoxes[index]!);
});

test('分割できない長いリンクラベルでも閲覧表示が横にはみ出さない', async ({ page }, testInfo) => {
  await loginE2eAccount(page, 'parity-e2e');
  const title = `editor-parity-overflow-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  await createPage(page, title, [UNBREAKABLE_LINK]);

  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto(`/e2e/${title}`);
  const viewport = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth);
});

test('画像を含む行も編集開始で行の高さが変わらない', async ({ page }, testInfo) => {
  await loginE2eAccount(page, 'parity-e2e');
  const title = `editor-parity-image-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  await createPage(page, title, ['https://i.gyazo.com/example.png', 'short body']);

  // 画像は外部ホストなので読み込ませない。大きさは CSS が決めるので、それで足りる。
  await page.route('https://i.gyazo.com/**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"></svg>' });
  });
  await page.goto(`/e2e/${title}`);
  await expect(page.locator('#editor-root .line-row img')).toBeVisible();
  const rowHeights = async (): Promise<number[]> => page.evaluate(() =>
    Array.from(
      document.querySelectorAll('#editor-root .line-row, #editor-root .cm-line'),
      (row) => Math.round(row.getBoundingClientRect().height),
    )
  );
  const before = await rowHeights();
  // 文字の無い行は lineTextBoxes では見えないので、行の箱の高さで見る。
  expect(before[1]!).toBeGreaterThan(before[2]!);

  await page.locator('#editor-root .line-row').nth(2).click({ position: lineRowClickPosition });
  await expect(page.locator('#editor-root .cm-content')).toBeFocused();
  expect(await rowHeights()).toEqual(before);
});
