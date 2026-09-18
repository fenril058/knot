import { expect, type Page } from '@playwright/test';

export async function loginProjectE2e(target: Page): Promise<void> {
  const response = await target.request.post('/api/knot/session', {
    headers: { 'X-Knot-Client': 'e2e' },
    data: { name: 'project-e2e', password: 'project-e2e-password' },
  });
  expect(response.ok()).toBe(true);
}

export async function loginRecoveryE2e(target: Page): Promise<void> {
  const response = await target.request.post('/api/knot/session', {
    headers: { 'X-Knot-Client': 'e2e' },
    data: { name: 'recovery-e2e', password: 'recovery-e2e-password' },
  });
  expect(response.ok()).toBe(true);
}

export async function loginDirectEditE2e(target: Page): Promise<void> {
  const response = await target.request.post('/api/knot/session', {
    headers: { 'X-Knot-Client': 'e2e' },
    data: { name: 'direct-edit-e2e', password: 'direct-edit-e2e-password' },
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
const lineRowClickPosition = { x: 20, y: 8 };

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

export async function replaceEditorLine(target: Page, index: number, text: string): Promise<void> {
  await target.locator('#editor-root .cm-line').nth(index).click();
  await target.keyboard.press('Home');
  await target.keyboard.press('Shift+End');
  await target.keyboard.insertText(text);
}
