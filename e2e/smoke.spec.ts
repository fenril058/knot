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

  await page.goto('/e2e/hello/edit');
  const editor = page.locator('#editor-root .cm-content');
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

  await page.goto('/e2e/hello/edit');
  await expect(page.locator('#editor-root .cm-content')).toContainText('knot editor smoke body');
  await collectViolations();

  expect(violations).toEqual([]);
});
