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
