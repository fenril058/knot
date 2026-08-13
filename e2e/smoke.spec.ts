import { test, expect } from '@playwright/test';

declare global {
  interface Window {
    cspViolationLog: string[];
  }
}

// 設計書「エディタのスモークテスト」: 開く、編集する、自動保存される、再読み込みで内容が残る。
// あわせて全画面で CSP violation が 0 件であることを監視する（style-src nonce 方式の回帰検知）。
test('エディタで書いて自動保存され、再読み込みで内容が残る', async ({ page }) => {
  const violations: string[] = [];
  await page.addInitScript(() => {
    window.cspViolationLog = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      window.cspViolationLog.push(`${event.violatedDirective}: ${event.blockedURI}`);
    });
  });
  const collectViolations = async (): Promise<void> => {
    violations.push(...await page.evaluate(() => window.cspViolationLog));
  };

  const login = await page.request.post('/api/knot/session', {
    headers: { 'X-Knot-Client': 'e2e' },
    data: { name: 'e2e', password: 'e2e-password' },
  });
  expect(login.ok()).toBe(true);

  await page.goto('/e2e/hello');
  await page.locator('#edit-page-button').click();
  const editor = page.locator('#editor-root .cm-content');
  await expect(page).toHaveURL(/\/e2e\/hello$/);
  await expect(editor).toBeFocused();
  await expect(editor).toContainText('hello');

  await editor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('knot editor smoke body');
  await expect(page.locator('#save-status')).toHaveText('保存済み');
  await collectViolations();

  await page.goto('/e2e/hello');
  await expect(page.locator('.page-body')).toContainText('knot editor smoke body');
  await collectViolations();

  await page.goto('/e2e/hello');
  await page.locator('#edit-page-button').click();
  await expect(page.locator('#editor-root .cm-content')).toContainText('knot editor smoke body');
  await collectViolations();

  expect(violations).toEqual([]);
});

test('400 で保存を拒否された後も追加入力して保存できる', async ({ page }) => {
  const login = await page.request.post('/api/knot/session', {
    headers: { 'X-Knot-Client': 'e2e' },
    data: { name: 'e2e', password: 'e2e-password' },
  });
  expect(login.ok()).toBe(true);

  let commitRequests = 0;
  await page.route('**/api/knot/pages/e2e/recover-after-400/commits', async (route) => {
    commitRequests += 1;
    if (commitRequests === 1) {
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'bad_commit', message: 'simulated rejection' }),
      });
      return;
    }
    await route.continue();
  });

  await page.goto('/e2e/recover-after-400');
  await page.locator('#edit-page-button').click();
  const editor = page.locator('#editor-root .cm-content');
  await expect(page).toHaveURL(/\/e2e\/recover-after-400$/);
  await expect(editor).toBeFocused();
  await editor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('rejected text');
  await expect(page.locator('#save-status')).toHaveText('エラー: simulated rejection');

  await page.keyboard.type(' corrected');
  await expect(page.locator('#save-status')).toHaveText('保存済み');
  expect(commitRequests).toBe(2);

  await page.goto('/e2e/recover-after-400');
  await expect(page.locator('.page-body')).toContainText('rejected text corrected');
});

test('選択行だけ原文にし、それ以外の行を整形表示する', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const login = await page.request.post('/api/knot/session', {
    headers: { 'X-Knot-Client': 'e2e' },
    data: { name: 'e2e', password: 'e2e-password' },
  });
  expect(login.ok()).toBe(true);
  const created = await page.request.post('/api/knot/pages/e2e/line-wysiwyg/commits', {
    headers: { 'X-Knot-Client': 'e2e' },
    data: {
      commitId: 'line-wysiwyg-commit',
      baseVersion: 0,
      ops: [
        { type: 'insert', id: 'line-wysiwyg-title', after: '_head', text: 'line-wysiwyg' },
        { type: 'insert', id: 'line-wysiwyg-body', after: 'line-wysiwyg-title', text: '[linked] [* bold]' },
        { type: 'insert', id: 'line-wysiwyg-indent', after: 'line-wysiwyg-body', text: '  nested' },
      ],
    },
  });
  expect(created.ok()).toBe(true);

  await page.goto('/e2e/line-wysiwyg');
  await expect(page.locator('.page-body .line-indent')).toHaveCount(2);
  await page.locator('#edit-page-button').click();

  const formatted = page.locator('.cm-wysiwyg-line[data-line-number="2"]');
  await expect(formatted.locator('a')).toHaveAttribute('href', '/e2e/linked');
  await expect(formatted.locator('strong')).toHaveText('bold');
  await expect(formatted).not.toContainText('[*');

  await formatted.locator('a').click();
  await expect(page).toHaveURL(/\/e2e\/linked$/);
  await page.goBack();
  await page.locator('#edit-page-button').click();

  await page.locator('.cm-wysiwyg-line[data-line-number="2"] strong').click();
  await expect(page.locator('#editor-root .cm-line').nth(1)).toContainText('[linked] [* bold]');
  await expect(page).toHaveURL(/\/e2e\/line-wysiwyg$/);

  await page.keyboard.press('Control+Enter');
  await expect(page).toHaveURL(/\/e2e\/linked$/);

  await page.goBack();
  await page.locator('#edit-page-button').click();
  await page.locator('.cm-wysiwyg-line[data-line-number="2"] strong').click();
  await page.keyboard.press('Shift+ArrowDown');
  await expect(page.locator('.cm-wysiwyg-line[data-line-number="3"]')).toHaveCount(0);
  await page.keyboard.press('Control+C');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('[linked] [* bold]');
});

test('JavaScript 無効でもログイン済み利用者は SSR 本文とリンクを読める', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, javaScriptEnabled: false });
  try {
    const login = await context.request.post('/api/knot/session', {
      headers: { 'X-Knot-Client': 'e2e' },
      data: { name: 'e2e', password: 'e2e-password' },
    });
    expect(login.ok()).toBe(true);
    const created = await context.request.post('/api/knot/pages/e2e/no-js/commits', {
      headers: { 'X-Knot-Client': 'e2e' },
      data: {
        commitId: 'no-js-commit',
        baseVersion: 0,
        ops: [
          { type: 'insert', id: 'no-js-title', after: '_head', text: 'no-js' },
          { type: 'insert', id: 'no-js-body', after: 'no-js-title', text: '[linked-page]' },
        ],
      },
    });
    expect(created.ok()).toBe(true);

    const page = await context.newPage();
    await page.goto('/e2e/no-js');

    await expect(page.locator('.page-body')).toContainText('linked-page');
    await expect(page.locator('.page-body a')).toHaveAttribute('href', '/e2e/linked-page');
    await expect(page.locator('.cm-editor')).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('カードのリンク領域が同じ行の高さまで広がる', async ({ page }) => {
  const login = await page.request.post('/api/knot/session', {
    headers: { 'X-Knot-Client': 'e2e' },
    data: { name: 'e2e', password: 'e2e-password' },
  });
  expect(login.ok()).toBe(true);
  const projectName = 'card-layout';
  const project = await page.request.post(`/api/knot/projects/${projectName}`, {
    headers: { 'X-Knot-Client': 'e2e' },
  });
  expect(project.ok()).toBe(true);

  for (const [title, lines] of [
    ['short-card', ['短い説明']],
    ['long-card', ['説明一', '説明二', '説明三', '説明四']],
  ] as const) {
    const ops = [title, ...lines].map((text, index) => ({
      type: 'insert' as const,
      id: `${title}-${index}`,
      after: index === 0 ? '_head' : `${title}-${index - 1}`,
      text,
    }));
    const created = await page.request.post(`/api/knot/pages/${projectName}/${title}/commits`, {
      headers: { 'X-Knot-Client': 'e2e' },
      data: { commitId: `${title}-commit`, baseVersion: 0, ops },
    });
    expect(created.ok()).toBe(true);
  }

  await page.goto(`/${projectName}`);

  const shortItem = page.locator(`.card[href="/${projectName}/short-card"]`).locator('..');
  const longItem = page.locator(`.card[href="/${projectName}/long-card"]`).locator('..');
  await expect(shortItem).toBeVisible();
  await expect(longItem).toBeVisible();
  expect((await shortItem.boundingBox())?.y).toBe((await longItem.boundingBox())?.y);

  for (const title of ['short-card', 'long-card']) {
    const card = page.locator(`.card[href="/${projectName}/${title}"]`);
    const item = card.locator('..');
    await expect(card).toBeVisible();
    await expect.poll(async () => (await card.boundingBox())?.height).toBe((await item.boundingBox())?.height);
  }
});
