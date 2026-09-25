import { expect, type Page } from '@playwright/test';

// login rate limit は ip と name の組で 10 分 10 回なので（src/server/app.ts の loginLimiter）、
// seed 済みアカウントは題材ごとに分ける。password は名前から決まる（e2e/server.ts）。
export async function loginE2eAccount(target: Page, name: string): Promise<void> {
  const response = await target.request.post('/api/knot/session', {
    headers: { 'X-Knot-Client': 'e2e' },
    data: { name, password: `${name}-password` },
  });
  expect(response.ok()).toBe(true);
}

export async function loginProjectE2e(target: Page): Promise<void> {
  await loginE2eAccount(target, 'project-e2e');
}

export async function loginRecoveryE2e(target: Page): Promise<void> {
  await loginE2eAccount(target, 'recovery-e2e');
}

export async function loginDirectEditE2e(target: Page): Promise<void> {
  await loginE2eAccount(target, 'direct-edit-e2e');
}

export async function loginTitleE2e(target: Page): Promise<void> {
  await loginE2eAccount(target, 'title-e2e');
}

// ページを 1 コミットで作る。行 ID は `${title}-line-${index}` で、テストから直接指せる。
export async function createE2ePage(target: Page, title: string, bodyLines: string[]): Promise<void> {
  const texts = [title, ...bodyLines];
  const ops = texts.map((text, index) => ({
    type: 'insert' as const,
    id: `${title}-line-${index}`,
    after: index === 0 ? '_head' : `${title}-line-${index - 1}`,
    text,
  }));
  const response = await target.request.post(`/api/knot/pages/e2e/${title}/commits`, {
    headers: { 'X-Knot-Client': 'e2e' },
    data: { commitId: `${title}-create`, baseVersion: 0, ops },
  });
  expect(response.ok()).toBe(true);
}

export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolver: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolver = resolve;
  });
  return {
    promise,
    resolve: () => {
      if (resolver === undefined) throw new Error('deferred promise resolver is missing');
      resolver();
    },
  };
}

// テロメアは行の左端 4px と margin 0.5rem を占め、click しても編集は始まらない。
// x = 20 はそれを外して行の文字列先頭を押す位置。
export const lineRowClickPosition = { x: 20, y: 8 };

// タイトルが画面上に何個見えているかを数える。閲覧時の見出しも Editor のタイトル行も、
// タイトル文字列だけを持つ葉要素として現れるので、表現が変わっても同じ数え方で観測できる。
export async function visibleTitleCount(target: Page, title: string): Promise<number> {
  return target.evaluate((expected) => {
    const main = document.querySelector('main');
    if (main === null) throw new Error('main element is missing');
    return Array.from(main.querySelectorAll<HTMLElement>('*')).filter((element) =>
      element.children.length === 0
      && element.textContent?.trim() === expected
      && element.checkVisibility()
    ).length;
  }, title);
}

// SSR 本文の行を click して編集を開始する。
// 未作成ページには行が無く、作成ボタンだけが編集開始の面になる。
// 回復ダイアログが挟まる経路ではエディタがすぐ現れないので、待たずに戻る。
export async function startEditing(target: Page, lineIndex = 1): Promise<void> {
  const creationButton = target.locator('#edit-page-button');
  if (await creationButton.count() > 0) {
    await creationButton.click();
    return;
  }
  const rows = target.locator('#editor-root .line-row');
  const count = await rows.count();
  if (count === 0) throw new Error('SSR editor row is missing');
  await rows.nth(Math.min(lineIndex, count - 1)).click({ position: lineRowClickPosition });
}

export async function activateEditor(target: Page, lineIndex = 1): Promise<void> {
  await startEditing(target, lineIndex);
  await expect(target.locator('#editor-root .cm-content')).toBeVisible();
}

export async function replaceEditorDocument(target: Page, texts: string[]): Promise<void> {
  const editor = target.locator('#editor-root .cm-content');
  await editor.click();
  await target.keyboard.press('Control+A');
  await target.keyboard.insertText(texts.join('\n'));
}

// 行が折り返すと Home / End は視覚行の端へ移るので、この置換は 1 行に収まる行だけで使う。
export async function replaceEditorLine(target: Page, index: number, text: string): Promise<void> {
  await target.locator('#editor-root .cm-line').nth(index).click();
  await target.keyboard.press('Home');
  await target.keyboard.press('Shift+End');
  await target.keyboard.insertText(text);
}
