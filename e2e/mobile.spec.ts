import { test, expect, type Page, type Response } from '@playwright/test';
import { loginProjectE2e } from './helpers.ts';

const expectedViewportWidths: Record<string, number> = {
  'mobile-chromium': 360,
  'mobile-webkit': 393,
};

async function expectMobileLayout(target: Page, expectedWidth: number): Promise<void> {
  const dimensions = await target.evaluate(() => ({
    innerWidth: window.innerWidth,
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.innerWidth).toBe(expectedWidth);
  expect(dimensions.clientWidth).toBe(expectedWidth);
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(expectedWidth);
}

function hasLineUpdate(body: unknown, lineId: string, text: string): boolean {
  if (typeof body !== 'object' || body === null || !('ops' in body) || !Array.isArray(body.ops)) return false;
  return body.ops.some((op: unknown) =>
    typeof op === 'object'
    && op !== null
    && 'type' in op
    && op.type === 'update'
    && 'id' in op
    && op.id === lineId
    && 'text' in op
    && op.text === text
  );
}

function isSuccessfulCommitWithLineUpdate(
  response: Response,
  commitUrl: string,
  lineId: string,
  text: string,
): boolean {
  if (
    !response.url().endsWith(commitUrl)
    || response.request().method() !== 'POST'
    || !response.ok()
  ) return false;

  try {
    return hasLineUpdate(response.request().postDataJSON(), lineId, text);
  } catch {
    return false;
  }
}

test('mobile browser でページを探して編集し、再読み込み後も内容が残る', async ({ page }, testInfo) => {
  const expectedWidth = expectedViewportWidths[testInfo.project.name];
  if (expectedWidth === undefined) throw new Error(`unexpected mobile project: ${testInfo.project.name}`);
  await loginProjectE2e(page);

  const title = `mobile-basic-flow-${testInfo.project.name}-${testInfo.repeatEachIndex}`;
  const created = await page.request.post(`/api/knot/pages/e2e/${title}/commits`, {
    headers: { 'X-Knot-Client': 'e2e' },
    data: {
      commitId: `${title}-create`,
      baseVersion: 0,
      ops: [
        { type: 'insert', id: `${title}-title`, after: '_head', text: title },
        {
          type: 'insert',
          id: `${title}-existing`,
          after: `${title}-title`,
          text: '変更前の既存行',
        },
      ],
    },
  });
  expect(created.ok()).toBe(true);

  await page.goto('/');
  await expectMobileLayout(page, expectedWidth);
  const projectLink = page.getByRole('link', { name: 'e2e', exact: true });
  await expect(projectLink).toBeInViewport();
  await projectLink.tap();
  await expect(page).toHaveURL('/e2e');
  await expectMobileLayout(page, expectedWidth);

  const search = page.getByRole('searchbox');
  await expect(search).toBeInViewport();
  const fullTextSearch = page.waitForResponse((response) =>
    response.url().includes(`/api/pages/e2e/search/query?q=${title}`)
    && response.ok()
  );
  await search.fill(title);
  await fullTextSearch;
  const searchHit = page.locator(`#search-results a.search-hit[href="/e2e/${title}"]`);
  await expect(searchHit).toHaveText(`${title}: ${title}`);
  await expect(searchHit).toBeVisible();
  await expect(searchHit).toBeInViewport();
  await searchHit.tap();
  await expect(page).toHaveURL(`/e2e/${title}`);
  await expectMobileLayout(page, expectedWidth);
  await expect(page.locator('.page-body')).toContainText('変更前の既存行');

  const editButton = page.getByRole('button', { name: '編集', exact: true });
  await expect(editButton).toBeInViewport();
  await editButton.tap();
  const editor = page.locator('#editor-root .cm-content');
  await expect(editor).toBeFocused();
  await expect(editor).toBeInViewport();
  await expectMobileLayout(page, expectedWidth);

  const finalLineText = 'mobile で変更した既存行';
  const finalDocument = [title, finalLineText, 'mobile で追加した行'];
  const finalSaveResponse = page.waitForResponse((response) =>
    isSuccessfulCommitWithLineUpdate(
      response,
      `/api/knot/pages/e2e/${title}/commits`,
      `${title}-existing`,
      finalLineText,
    )
  );
  const existingLine = page.locator('.cm-wysiwyg-line[data-line-number="2"]');
  await expect(existingLine).toBeInViewport();
  await existingLine.tap();
  await expect(editor).toBeFocused();
  await page.keyboard.press('End');
  // Playwright does not open a software keyboard; insertText dispatches the input event
  // that adds the newline and text to CodeMirror's contenteditable element.
  await page.keyboard.insertText('\nmobile で追加した行');
  await expect(page.locator('#editor-root .cm-line')).toHaveText([
    title,
    '変更前の既存行',
    'mobile で追加した行',
  ]);
  await existingLine.tap();
  await expect(editor).toBeFocused();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
  await page.keyboard.insertText(finalLineText);

  // The existing-line update is the last user mutation. SyncEngine sends one
  // commit at a time, so its successful response also follows any split insert.
  await finalSaveResponse;
  await expect(page.locator('#save-status')).toHaveText('保存済み');
  await expect(page.locator('#editor-root .cm-line')).toHaveText(finalDocument);
  const persisted = await page.request.get(`/api/pages/e2e/${title}`);
  expect(persisted.ok()).toBe(true);
  expect((await persisted.json()).lines.map((line: { text: string }) => line.text)).toEqual(finalDocument);

  await page.reload();
  await expectMobileLayout(page, expectedWidth);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);
  await expect(page.locator('.page-body .line-row')).toHaveText([
    '',
    'mobile で変更した既存行',
    'mobile で追加した行',
  ]);
});
