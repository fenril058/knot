import { randomUUID } from 'node:crypto';
import { expect, request, test } from '@playwright/test';
import { replaceEditorLine } from '../helpers.ts';

const mutationHeaders = { 'X-Knot-Client': 'dogfood-smoke' };

test.beforeAll(() => {
  if (!/^https:\/\/[^/]+$/u.test(process.env.KNOT_PRODUCTION_URL ?? '')) {
    throw new Error('KNOT_PRODUCTION_URL must be an HTTPS origin');
  }
});

function pageSnapshot(value: unknown): { id: string; version: number; texts: string[] } {
  if (
    typeof value !== 'object' || value === null ||
    !('id' in value) || typeof value.id !== 'string' ||
    !('version' in value) || typeof value.version !== 'number' ||
    !('lines' in value) || !Array.isArray(value.lines)
  ) throw new Error('unexpected page response');
  const texts: string[] = [];
  for (const line of value.lines) {
    const entry: unknown = line;
    if (typeof entry !== 'object' || entry === null || !('text' in entry) || typeof entry.text !== 'string') {
      throw new Error('unexpected page line');
    }
    texts.push(entry.text);
  }
  return { id: value.id, version: value.version, texts };
}

test('Access protects HTML, API, CSS and browser script', async ({ baseURL }) => {
  if (baseURL === undefined) throw new Error('baseURL is required');
  const anonymous = await request.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  try {
    for (const path of ['/', '/api/pages/dogfood-smoke', '/assets/app.css', '/assets/build/editor.js']) {
      const response = await anonymous.get(path, { maxRedirects: 0 });
      expect(response.status(), `${path} is available without Access`).not.toBe(200);
    }
  } finally {
    await anonymous.dispose();
  }
});

test('authenticated browser creates, edits, reloads and searches persistent content', async ({ page, isMobile }) => {
  const suffix = randomUUID().slice(0, 12);
  const project = `dogfood-smoke-${suffix}`;
  const title = `sentinel-${suffix}`;

  await page.goto('/');
  await expect(page.locator('#create-project-name')).toBeVisible();
  await page.locator('#create-project-name').fill(project);
  await page.locator('#create-project-name').press('Enter');
  await expect(page).toHaveURL(`/${project}`);

  await page.goto(`/${project}/${title}`);
  await page.locator('#edit-page-button').click();
  const editor = page.locator('#editor-root .cm-content');
  await editor.click();
  await page.keyboard.press(isMobile ? 'Meta+A' : 'Control+A');
  await page.keyboard.insertText([title, 'before deploy'].join('\n'));
  await expect(page.locator('#save-status')).toHaveText('保存済み');
  const snapshot = await page.request.get(`/api/pages/${project}/${title}`);
  expect(snapshot.ok()).toBe(true);
  const saved = pageSnapshot(await snapshot.json());
  expect(saved.texts).toEqual([title, 'before deploy']);

  await page.reload();
  await expect(page.locator('.page-body')).toContainText('before deploy');
  await page.locator('#edit-page-button').click();
  await replaceEditorLine(page, 1, 'edited before deploy');
  await expect(page.locator('#save-status')).toHaveText('保存済み');
  const edited = pageSnapshot(await (await page.request.get(`/api/pages/${project}/${title}`)).json());
  expect(edited.id).toBe(saved.id);
  expect(edited.version).toBeGreaterThan(saved.version);
  expect(edited.texts).toEqual([title, 'edited before deploy']);
  await page.reload();
  await expect(page.locator('.page-body')).toContainText('edited before deploy');
  await page.goto(`/${project}`);
  const search = page.getByRole('searchbox');
  await search.fill(title);
  await expect(page.locator(`#search-results a.search-hit[href="/${project}/${title}"]`)).toBeVisible();
  console.log(JSON.stringify({ project, title, id: edited.id, version: edited.version, text: 'edited before deploy' }));
});

test('two browser contexts reject stale edit and stale delete', async ({ browser, page, baseURL }) => {
  const suffix = randomUUID().slice(0, 12);
  const project = `dogfood-conflict-${suffix}`;
  const title = `page-${suffix}`;
  const state = process.env.KNOT_ACCESS_STATE ?? '.dev/access-state.json';
  const otherContext = await browser.newContext({ storageState: state, baseURL });
  const other = await otherContext.newPage();
  try {
    const createdProject = await page.request.post(`/api/knot/projects/${project}`, { headers: mutationHeaders });
    expect(createdProject.ok()).toBe(true);
    const createdPage = await page.request.post(`/api/knot/pages/${project}/${title}/commits`, {
      headers: mutationHeaders,
      data: {
        commitId: randomUUID(), baseVersion: 0,
        ops: [
          { type: 'insert', id: `${suffix}-title`, after: '_head', text: title },
          { type: 'insert', id: `${suffix}-body`, after: `${suffix}-title`, text: 'base' },
        ],
      },
    });
    expect(createdPage.ok()).toBe(true);
    const initial = await page.request.get(`/api/pages/${project}/${title}`);
    const snapshot = pageSnapshot(await initial.json());

    await Promise.all([page.goto(`/${project}/${title}`), other.goto(`/${project}/${title}`)]);
    await Promise.all([page.locator('#edit-page-button').click(), other.locator('#edit-page-button').click()]);
    await replaceEditorLine(page, 1, 'saved first');
    await expect(page.locator('#save-status')).toHaveText('保存済み');
    await replaceEditorLine(other, 1, 'stale second');
    await expect(other.locator('#edit-conflict')).toBeVisible();

    const staleDelete = await page.request.delete(`/api/knot/pages/${project}/${title}`, {
      headers: mutationHeaders,
      data: { pageId: snapshot.id, baseVersion: snapshot.version },
    });
    expect(staleDelete.status()).toBe(409);
    const current = await page.request.get(`/api/pages/${project}/${title}`);
    expect(current.ok()).toBe(true);
    const currentSnapshot = pageSnapshot(await current.json());
    expect(currentSnapshot.texts).toEqual([title, 'saved first']);

    const staleRename = await page.request.post(`/api/knot/pages/${project}/${title}/rename`, {
      headers: mutationHeaders,
      data: { pageId: snapshot.id, baseVersion: snapshot.version, newTitle: `${title}-stale`, rewriteLinks: true },
    });
    expect(staleRename.status()).toBe(409);

    const sourceTitle = `source-${suffix}`;
    const sourceCreated = await page.request.post(`/api/knot/pages/${project}/${sourceTitle}/commits`, {
      headers: mutationHeaders,
      data: {
        commitId: randomUUID(), baseVersion: 0,
        ops: [
          { type: 'insert', id: `${suffix}-source-title`, after: '_head', text: sourceTitle },
          { type: 'insert', id: `${suffix}-source-body`, after: `${suffix}-source-title`, text: `[${title}]` },
        ],
      },
    });
    expect(sourceCreated.ok()).toBe(true);
    const newTitle = `${title}-renamed`;
    const renamed = await page.request.post(`/api/knot/pages/${project}/${title}/rename`, {
      headers: mutationHeaders,
      data: { pageId: snapshot.id, baseVersion: currentSnapshot.version, newTitle, rewriteLinks: true },
    });
    expect(renamed.ok()).toBe(true);
    const renamedPage = pageSnapshot(await (await page.request.get(`/api/pages/${project}/${newTitle}`)).json());
    expect(renamedPage.id).toBe(snapshot.id);
    const rewrittenSource = pageSnapshot(await (await page.request.get(`/api/pages/${project}/${sourceTitle}`)).json());
    expect(rewrittenSource.texts).toEqual([sourceTitle, `[${newTitle}]`]);
  } finally {
    await otherContext.close();
  }
});
