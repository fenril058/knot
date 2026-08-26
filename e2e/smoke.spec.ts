import { test, expect, type Page } from '@playwright/test';

declare global {
  interface Window {
    cspViolationLog: string[];
  }
}

async function replaceEditorDocument(target: Page, texts: string[]): Promise<void> {
  const editor = target.locator('#editor-root .cm-content');
  await editor.click();
  await target.keyboard.press('Control+A');
  await target.keyboard.insertText(texts.join('\n'));
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

  await page.reload();
  await page.locator('#edit-page-button').click();
  await expect(page.locator('#editor-root .cm-content')).toContainText('rejected text');
  await page.locator('#editor-root .cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' corrected');
  await expect(page.locator('#save-status')).toHaveText('保存済み');
  expect(commitRequests).toBe(2);

  await page.goto('/e2e/recover-after-400');
  await expect(page.locator('.page-body')).toContainText('rejected text corrected');
});

test('同一行の並行編集は自動上書きせず、手元の内容を明示的に保存できる', async ({ page }) => {
  const login = await page.request.post('/api/knot/session', {
    headers: { 'X-Knot-Client': 'e2e' },
    data: { name: 'e2e', password: 'e2e-password' },
  });
  expect(login.ok()).toBe(true);

  const title = 'same-line-conflict';
  const created = await page.request.post(`/api/knot/pages/e2e/${title}/commits`, {
    headers: { 'X-Knot-Client': 'e2e' },
    data: {
      commitId: 'same-line-conflict-create',
      baseVersion: 0,
      ops: [
        { type: 'insert', id: 'same-line-title', after: '_head', text: title },
        { type: 'insert', id: 'same-line-body', after: 'same-line-title', text: 'base' },
      ],
    },
  });
  expect(created.ok()).toBe(true);

  const other = await page.context().newPage();
  await Promise.all([page.goto(`/e2e/${title}`), other.goto(`/e2e/${title}`)]);
  await Promise.all([
    page.locator('#edit-page-button').click(),
    other.locator('#edit-page-button').click(),
  ]);

  await replaceEditorDocument(page, [title, 'server change']);
  await expect(page.locator('#save-status')).toHaveText('保存済み');

  await replaceEditorDocument(other, [title, 'local change']);
  await expect(other.locator('#edit-conflict')).toBeVisible();
  await expect(other.locator('#save-status')).toContainText('自動保存を停止しました');
  await expect(other.locator('#edit-conflict')).toContainText('base');
  await expect(other.locator('#edit-conflict')).toContainText('local change');
  await expect(other.locator('#edit-conflict')).toContainText('server change');
  await expect(other.locator('#editor-root .cm-content')).toContainText('local change');

  const beforeResolution = await other.request.get(`/api/pages/e2e/${title}`);
  expect((await beforeResolution.json()).lines[1].text).toBe('server change');

  await replaceEditorDocument(other, [title, 'edited during conflict']);
  await other.reload();
  await other.locator('#edit-page-button').click();
  await expect(other.locator('#edit-conflict')).toBeVisible();
  await expect(other.locator('#editor-root .cm-content')).toContainText('edited during conflict');

  await other.locator('#resolve-edit-conflict').click();
  await expect(other.locator('#save-status')).toHaveText('保存済み');
  await expect(other.locator('#edit-conflict')).toBeHidden();

  const resolved = await other.request.get(`/api/pages/e2e/${title}`);
  expect((await resolved.json()).lines[1].text).toBe('edited during conflict');
  await other.close();
});

test('異なる行の並行編集はカーソルと undo 履歴を維持して最新版へリベースする', async ({ page }) => {
  const login = await page.request.post('/api/knot/session', {
    headers: { 'X-Knot-Client': 'e2e' },
    data: { name: 'e2e', password: 'e2e-password' },
  });
  expect(login.ok()).toBe(true);

  const title = 'different-line-rebase';
  const created = await page.request.post(`/api/knot/pages/e2e/${title}/commits`, {
    headers: { 'X-Knot-Client': 'e2e' },
    data: {
      commitId: 'different-line-rebase-create',
      baseVersion: 0,
      ops: [
        { type: 'insert', id: 'different-title', after: '_head', text: title },
        { type: 'insert', id: 'different-first', after: 'different-title', text: 'first base' },
        { type: 'insert', id: 'different-second', after: 'different-first', text: 'second base' },
        { type: 'insert', id: 'different-tail', after: 'different-second', text: 'tail' },
      ],
    },
  });
  expect(created.ok()).toBe(true);

  const other = await page.context().newPage();
  await Promise.all([page.goto(`/e2e/${title}`), other.goto(`/e2e/${title}`)]);
  await Promise.all([page.locator('#edit-page-button').click(), other.locator('#edit-page-button').click()]);

  await replaceEditorDocument(page, [title, 'first remote', 'remote inserted', 'second base', 'tail']);
  await expect(page.locator('#save-status')).toHaveText('保存済み');

  await other.locator('#editor-root .cm-line').nth(2).click();
  await other.keyboard.press('End');
  await other.keyboard.type(' local');
  await expect(other.locator('#save-status')).toHaveText('保存済み');
  await expect(other.locator('#editor-root .cm-content')).toContainText('first remote');
  await expect(other.locator('#editor-root .cm-content')).toContainText('remote inserted');
  await expect(other.locator('#editor-root .cm-content')).toContainText('second base local');

  await other.keyboard.type(' continued');
  await expect(other.locator('#save-status')).toHaveText('保存済み');
  const saved = await other.request.get(`/api/pages/e2e/${title}`);
  expect((await saved.json()).lines.map((line: { text: string }) => line.text)).toEqual([
    title,
    'first remote',
    'remote inserted',
    'second base local continued',
    'tail',
  ]);

  await other.keyboard.press('Control+z');
  await expect(other.locator('#editor-root .cm-line')).toHaveText([
    title,
    'first remote',
    'remote inserted',
    'second base local',
    'tail',
  ]);
  await expect(other.locator('#save-status')).toHaveText('保存済み');

  await other.keyboard.press('Control+z');
  await expect(other.locator('#editor-root .cm-line')).toHaveText([
    title,
    'first remote',
    'remote inserted',
    'second base',
    'tail',
  ]);
  await expect(other.locator('#save-status')).toHaveText('保存済み');

  await other.keyboard.press('Control+z');
  await expect(other.locator('#editor-root .cm-line')).toHaveText([
    title,
    'first remote',
    'remote inserted',
    'second base',
    'tail',
  ]);

  await other.keyboard.press('Control+Shift+z');
  await expect(other.locator('#editor-root .cm-line')).toHaveText([
    title,
    'first remote',
    'remote inserted',
    'second base local',
    'tail',
  ]);
  await expect(other.locator('#save-status')).toHaveText('保存済み');

  const redone = await other.request.get(`/api/pages/e2e/${title}`);
  expect((await redone.json()).lines.map((line: { text: string }) => line.text)).toEqual([
    title,
    'first remote',
    'remote inserted',
    'second base local',
    'tail',
  ]);
  await other.close();
});

test('編集開始前にリネームされても pageId から最新版を開く', async ({ page }) => {
  const login = await page.request.post('/api/knot/session', {
    headers: { 'X-Knot-Client': 'e2e' },
    data: { name: 'e2e', password: 'e2e-password' },
  });
  expect(login.ok()).toBe(true);
  const oldTitle = 'rename-before-edit';
  const newTitle = 'renamed-before-edit';
  const created = await page.request.post(`/api/knot/pages/e2e/${oldTitle}/commits`, {
    headers: { 'X-Knot-Client': 'e2e' },
    data: {
      commitId: 'rename-before-edit-create',
      baseVersion: 0,
      ops: [{ type: 'insert', id: 'rename-before-edit-title', after: '_head', text: oldTitle }],
    },
  });
  const { pageId } = await created.json();
  await page.goto(`/e2e/${oldTitle}`);
  const renamed = await page.request.post(`/api/knot/pages/e2e/${oldTitle}/commits`, {
    headers: { 'X-Knot-Client': 'e2e' },
    data: {
      pageId,
      commitId: 'rename-before-edit-rename',
      baseVersion: 1,
      ops: [{ type: 'update', id: 'rename-before-edit-title', text: newTitle }],
    },
  });
  expect(renamed.ok()).toBe(true);

  await page.locator('#edit-page-button').click();

  await expect(page).toHaveURL(`/e2e/${newTitle}`);
  await expect(page.locator('#editor-root .cm-content')).toContainText(newTitle);
});

test('pageId とタイトルの回復キーから未保存草稿を復元する', async ({ page }) => {
  const login = await page.request.post('/api/knot/session', {
    headers: { 'X-Knot-Client': 'e2e' },
    data: { name: 'e2e', password: 'e2e-password' },
  });
  expect(login.ok()).toBe(true);
  {
  const oldTitle = 'rename-after-draft';
  const newTitle = 'renamed-after-draft';
  const created = await page.request.post(`/api/knot/pages/e2e/${oldTitle}/commits`, {
    headers: { 'X-Knot-Client': 'e2e' },
    data: {
      commitId: 'rename-after-draft-create',
      baseVersion: 0,
      ops: [
        { type: 'insert', id: 'rename-after-draft-title', after: '_head', text: oldTitle },
        { type: 'insert', id: 'rename-after-draft-body', after: 'rename-after-draft-title', text: 'base' },
      ],
    },
  });
  const { pageId } = await created.json();
  const beforeRename = await page.request.get(`/api/pages/e2e/${oldTitle}`);
  const snapshot = await beforeRename.json();

  await page.goto(`/e2e/${oldTitle}`);
  await page.evaluate(({ key, record }) => {
    localStorage.setItem(key, JSON.stringify(record));
  }, {
    key: `knot:pending:e2e/page:${pageId}`,
    record: {
      kind: 'unsaved-draft',
      confirmed: {
        version: snapshot.version,
        lines: snapshot.lines.map((line: object) => ({ ...line, updatedVersion: snapshot.version })),
      },
      title: oldTitle,
      texts: [oldTitle, 'local draft'],
      pageId,
    },
  });
  const renamed = await page.request.post(`/api/knot/pages/e2e/${oldTitle}/commits`, {
    headers: { 'X-Knot-Client': 'e2e' },
    data: {
      pageId,
      commitId: 'rename-after-draft-rename',
      baseVersion: snapshot.version,
      ops: [{ type: 'update', id: 'rename-after-draft-title', text: newTitle }],
    },
  });
  expect(renamed.ok()).toBe(true);

  await page.goto(`/e2e/${newTitle}`);
  await page.locator('#edit-page-button').click();
  const editor = page.locator('#editor-root .cm-content');
  await expect(page).toHaveURL(`/e2e/${newTitle}`);
  await expect(editor).toContainText('local draft');
  await editor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' corrected');
  await expect(page.locator('#save-status')).toHaveText('保存済み');

  const saved = await page.request.get(`/api/pages/e2e/${newTitle}`);
  expect((await saved.json()).lines.map((line: { text: string }) => line.text)).toEqual([
    newTitle,
    'local draft corrected',
  ]);
  }

  {
  const title = 'recover-applied-insert';
  const created = await page.request.post(`/api/knot/pages/e2e/${title}/commits`, {
    headers: { 'X-Knot-Client': 'e2e' },
    data: {
      commitId: 'recover-applied-insert-create',
      baseVersion: 0,
      ops: [
        { type: 'insert', id: 'recover-title', after: '_head', text: title },
        { type: 'insert', id: 'recover-body', after: 'recover-title', text: 'body' },
      ],
    },
  });
  const { pageId } = await created.json();
  const baseResponse = await page.request.get(`/api/pages/e2e/${title}`);
  const base = await baseResponse.json();
  const pendingOps = [{ type: 'insert', id: 'recover-insert', after: 'recover-body', text: 'inserted' }];
  const applied = await page.request.post(`/api/knot/pages/e2e/${title}/commits`, {
    headers: { 'X-Knot-Client': 'e2e' },
    data: {
      pageId,
      commitId: 'recover-applied-insert-pending',
      baseVersion: base.version,
      ops: pendingOps,
    },
  });
  expect(applied.ok()).toBe(true);
  const remote = await page.request.post(`/api/knot/pages/e2e/${title}/commits`, {
    headers: { 'X-Knot-Client': 'e2e' },
    data: {
      pageId,
      commitId: 'recover-applied-insert-remote',
      baseVersion: base.version + 1,
      ops: [{ type: 'update', id: 'recover-body', text: 'remote body' }],
    },
  });
  expect(remote.ok()).toBe(true);

  await page.goto(`/e2e/${title}`);
  await page.evaluate(({ key, record }) => {
    localStorage.setItem(key, JSON.stringify(record));
  }, {
    key: `knot:pending:e2e/page:${pageId}`,
    record: {
      commitId: 'recover-applied-insert-pending',
      baseVersion: base.version,
      ops: pendingOps,
      baseLines: base.lines.map((line: object) => ({ ...line, updatedVersion: base.version })),
      title,
      pageId,
      draftTexts: [title, 'body', 'inserted-then-edited'],
    },
  });
  await page.reload();
  await page.locator('#edit-page-button').click();

  const editor = page.locator('#editor-root .cm-content');
  await expect(editor).toContainText('remote body');
  await expect(editor).toContainText('inserted-then-edited');
  await expect(page.locator('#save-status')).toHaveText('保存済み');
  const saved = await page.request.get(`/api/pages/e2e/${title}`);
  expect((await saved.json()).lines.map((line: { text: string }) => line.text)).toEqual([
    title,
    'remote body',
    'inserted-then-edited',
  ]);
  }

  {
  const title = 'recover-created-page';
  const pendingOps = [{ type: 'insert', id: 'recover-created-title', after: '_head', text: title }];
  const created = await page.request.post(`/api/knot/pages/e2e/${title}/commits`, {
    headers: { 'X-Knot-Client': 'e2e' },
    data: {
      commitId: 'recover-created-page-pending',
      baseVersion: 0,
      ops: pendingOps,
    },
  });
  expect(created.ok()).toBe(true);

  await page.goto(`/e2e/${title}`);
  await page.evaluate(({ key, record }) => {
    localStorage.setItem(key, JSON.stringify(record));
  }, {
    key: `knot:pending:e2e/title:${title}`,
    record: {
      commitId: 'recover-created-page-pending',
      baseVersion: 0,
      ops: pendingOps,
      baseLines: [],
      title,
      draftTexts: [title, 'draft after send'],
    },
  });
  await page.reload();
  await page.locator('#edit-page-button').click();

  await expect(page.locator('#editor-root .cm-content')).toContainText('draft after send');
  await expect(page.locator('#save-status')).toHaveText('保存済み');
  }
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
  await expect(page.locator('.page-body .line-indent-prefix')).toHaveCount(1);
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

test('編集表示はSSRと同じリンク解決とブロック再分類を行う', async ({ page }) => {
  const login = await page.request.post('/api/knot/session', {
    headers: { 'X-Knot-Client': 'e2e' },
    data: { name: 'e2e', password: 'e2e-password' },
  });
  expect(login.ok()).toBe(true);

  const target = await page.request.post('/api/knot/pages/e2e/Canonical_Target/commits', {
    headers: { 'X-Knot-Client': 'e2e' },
    data: {
      commitId: 'line-wysiwyg-parity-target',
      baseVersion: 0,
      ops: [
        { type: 'insert', id: 'parity-target-title', after: '_head', text: 'Canonical Target' },
        {
          type: 'insert',
          id: 'parity-target-image',
          after: 'parity-target-title',
          text: 'https://i.gyazo.com/example.png',
        },
      ],
    },
  });
  expect(target.ok()).toBe(true);

  const source = await page.request.post('/api/knot/pages/e2e/line-wysiwyg-parity/commits', {
    headers: { 'X-Knot-Client': 'e2e' },
    data: {
      commitId: 'line-wysiwyg-parity-source',
      baseVersion: 0,
      ops: [
        { type: 'insert', id: 'parity-title', after: '_head', text: 'line-wysiwyg-parity' },
        {
          type: 'insert',
          id: 'parity-links',
          after: 'parity-title',
          text: '[canonical_target] [Missing] [Canonical Target.icon]',
        },
        {
          type: 'insert',
          id: 'parity-quote',
          after: 'parity-links',
          text: '[" https://i.gyazo.com/quoted.png [relative.png]]',
        },
        { type: 'insert', id: 'parity-table', after: 'parity-quote', text: 'table:t' },
        { type: 'insert', id: 'parity-row', after: 'parity-table', text: ' a\tb' },
      ],
    },
  });
  expect(source.ok()).toBe(true);

  await page.goto('/e2e/line-wysiwyg-parity');
  await expect(page.locator('.page-body a[href="/e2e/Canonical_Target"]')).toHaveCount(2);
  await expect(page.locator('.page-body .empty-link')).toHaveText('Missing');
  await expect(page.locator('.page-body .icon-img')).toHaveAttribute('src', 'https://i.gyazo.com/example.png');
  await expect(page.locator('.page-body')).not.toContainText('relative.png');

  await page.locator('#edit-page-button').click();
  const links = page.locator('.cm-wysiwyg-line[data-line-number="2"]');
  await expect(links.locator('a[href="/e2e/Canonical_Target"]')).toHaveCount(2);
  await expect(links.locator('.empty-link')).toHaveText('Missing');
  await expect(links.locator('.icon-img')).toHaveAttribute('src', 'https://i.gyazo.com/example.png');
  await expect(page.locator('.cm-wysiwyg-line[data-line-number="3"]')).not.toContainText('relative.png');

  const tableRow = page.locator('.cm-wysiwyg-line[data-line-number="5"]');
  await expect(tableRow.locator('table')).toHaveCount(1);
  await expect(tableRow.locator('.line-indent-prefix')).toHaveCount(0);
  await page.locator('.cm-wysiwyg-line[data-line-number="4"] .table-header').click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
  await page.keyboard.type('plainxx');
  await expect(tableRow.locator('table')).toHaveCount(0);
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
