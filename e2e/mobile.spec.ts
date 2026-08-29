import { devices, test, expect } from '@playwright/test';
import { loginProjectE2e, replaceEditorLine } from './helpers.ts';

const mobileDevice = devices['Pixel 5'];
// Pixel 5 represents a common smartphone portrait viewport (393 × 727 CSS px)
// and adds Chromium-compatible touch/mobile emulation instead of resizing a desktop page alone.
test.use({ ...mobileDevice });

test('mobile viewport でページを探して編集し、再読み込み後も内容が残る', async ({ page }) => {
  expect(page.viewportSize()).toEqual(mobileDevice.viewport);
  await loginProjectE2e(page);

  const title = 'mobile-basic-flow';
  const created = await page.request.post(`/api/knot/pages/e2e/${title}/commits`, {
    headers: { 'X-Knot-Client': 'e2e' },
    data: {
      commitId: 'mobile-basic-flow-create',
      baseVersion: 0,
      ops: [
        { type: 'insert', id: 'mobile-basic-flow-title', after: '_head', text: title },
        {
          type: 'insert',
          id: 'mobile-basic-flow-existing',
          after: 'mobile-basic-flow-title',
          text: '変更前の既存行',
        },
      ],
    },
  });
  expect(created.ok()).toBe(true);

  await page.goto('/');
  await page.getByRole('link', { name: 'e2e', exact: true }).click();
  await expect(page).toHaveURL('/e2e');

  const search = page.getByRole('searchbox');
  await search.fill(title);
  const searchHit = page.getByRole('link', { name: title, exact: true });
  await expect(searchHit).toBeVisible();
  await searchHit.click();
  await expect(page).toHaveURL(`/e2e/${title}`);
  await expect(page.locator('.page-body')).toContainText('変更前の既存行');

  await page.getByRole('button', { name: '編集', exact: true }).click();
  const editor = page.locator('#editor-root .cm-content');
  await expect(editor).toBeFocused();

  const saveResponse = page.waitForResponse((response) =>
    response.url().endsWith(`/api/knot/pages/e2e/${title}/commits`)
    && response.request().method() === 'POST'
    && response.ok()
  );
  await page.locator('#editor-root .cm-line').nth(1).click();
  await page.keyboard.press('End');
  // Playwright does not open a software keyboard; insertText dispatches the input event
  // that adds the newline and text to CodeMirror's contenteditable element.
  await page.keyboard.insertText('\nmobile で追加した行');
  await expect(page.locator('#editor-root .cm-line')).toHaveText([
    title,
    '変更前の既存行',
    'mobile で追加した行',
  ]);
  await replaceEditorLine(page, 1, 'mobile で変更した既存行');

  await saveResponse;
  await expect(page.locator('#save-status')).toHaveText('保存済み');
  await expect(page.locator('#editor-root .cm-line')).toHaveText([
    title,
    'mobile で変更した既存行',
    'mobile で追加した行',
  ]);

  await page.reload();
  await expect(page.locator('.page-body')).toContainText('mobile で変更した既存行');
  await expect(page.locator('.page-body')).toContainText('mobile で追加した行');
});
