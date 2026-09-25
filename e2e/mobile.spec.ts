import { test, expect, type Page, type Response } from '@playwright/test';
import { loginProjectE2e, loginTitleE2e, visibleTitleCount } from './helpers.ts';

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
  // 検索も編集開始も module script が listener を付けてから効く。toHaveURL は読み込みを
  // 待たないので、遷移直後に操作すると listener が付く前の入力が捨てられる。
  await page.waitForLoadState();
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
  await page.waitForLoadState();
  await expectMobileLayout(page, expectedWidth);
  await expect(page.locator('.page-body')).toContainText('変更前の既存行');
  await expect(page.getByRole('button', { name: '編集', exact: true })).toHaveCount(0);

  const existingSsrLine = page.locator('.page-body .line-row').nth(1);
  await expect(existingSsrLine).toBeInViewport();
  await existingSsrLine.tap();
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
  const activeExistingLine = page.locator('#editor-root .cm-line').nth(1);
  await expect(activeExistingLine).toContainText('変更前の既存行');
  await expect(activeExistingLine).toBeInViewport();
  await page.keyboard.press('End');
  // Playwright does not open a software keyboard; insertText dispatches the input event
  // that adds the newline and text to CodeMirror's contenteditable element.
  await page.keyboard.insertText('\nmobile で追加した行');
  await expect(page.locator('#editor-root .cm-line')).toHaveText([
    title,
    '変更前の既存行',
    'mobile で追加した行',
  ]);
  const existingLine = page.locator('.cm-wysiwyg-line[data-line-number="2"]');
  await expect(existingLine).toBeInViewport();
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
    title,
    'mobile で変更した既存行',
    'mobile で追加した行',
  ]);
});

test('mobile browser は見えているタイトルの tap から title 行の編集に入る', async ({ page }, testInfo) => {
  const expectedWidth = expectedViewportWidths[testInfo.project.name];
  if (expectedWidth === undefined) throw new Error(`unexpected mobile project: ${testInfo.project.name}`);
  await loginTitleE2e(page);

  const title = `mobile-title-tap-${testInfo.project.name}-${testInfo.repeatEachIndex}`;
  const created = await page.request.post(`/api/knot/pages/e2e/${title}/commits`, {
    headers: { 'X-Knot-Client': 'e2e' },
    data: {
      commitId: `${title}-create`,
      baseVersion: 0,
      ops: [
        { type: 'insert', id: `${title}-title`, after: '_head', text: title },
        { type: 'insert', id: `${title}-existing`, after: `${title}-title`, text: 'mobile の本文' },
      ],
    },
  });
  expect(created.ok()).toBe(true);

  await page.goto(`/e2e/${title}`);
  await expectMobileLayout(page, expectedWidth);
  const heading = page.getByRole('heading', { level: 1 });
  await expect(heading).toHaveText(title);
  await expect(heading).toBeInViewport();
  expect(await visibleTitleCount(page, title)).toBe(1);

  await heading.tap();
  await expect(page.locator('#editor-root .cm-content')).toBeFocused();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);
  await expect(page.locator('#editor-root .cm-line').first()).toHaveText(title);
  expect(await visibleTitleCount(page, title)).toBe(1);
  await page.keyboard.press('End');
  await page.keyboard.insertText('-edited');
  await expect(page.locator('#editor-root .cm-line')).toHaveText([`${title}-edited`, 'mobile の本文']);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`${title}-edited`);
  await expectMobileLayout(page, expectedWidth);
});
