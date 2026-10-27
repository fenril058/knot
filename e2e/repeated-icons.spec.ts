import { test, expect } from '@playwright/test';
import { createE2ePage, loginE2eAccount } from './helpers.ts';

test('繰り返しアイコンを表示・編集・保存し、再読み込み後も表示とリンク先を保つ', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const imageUrl = 'https://i.gyazo.com/repeated-icons.png';
  // 外部への通信に依存せず、画像として読み込めたことも確認する。
  await page.route(imageUrl, (route) => route.fulfill({
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path fill="#3467c9" d="M0 0h24v24H0z"/></svg>',
  }));
  await loginE2eAccount(page, 'icons-e2e');
  const suffix = `${testInfo.project.name}-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  const target = `icon-${suffix}`;
  const title = `repeated-icons-${suffix}`;
  await createE2ePage(page, target, [imageUrl]);
  const original = `通常 [${target}.icon*3] 後`;
  const body = [
    original,
    `連続 [${target}.icon*2][${target}.icon*2] 後`,
    `強調 [[${target}.icon*2]] 後`,
    `装飾 [* [${target}.icon*3]] 後`,
    'other [* bold] content',
  ];
  await createE2ePage(page, title, body);
  await page.goto(`/e2e/${title}`);
  const root = page.locator('#editor-root');
  await expect(root.locator('.icon-img')).toHaveCount(12);
  for (const [index, count] of [3, 4, 2, 3].entries()) {
    await expect(root.locator('.line-row').nth(index + 1).locator('.icon-img')).toHaveCount(count);
  }
  await expect.poll(() => root.locator('.icon-img').evaluateAll((images) =>
    images.every((image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0)
  )).toBe(true);

  await root.getByRole('heading', { level: 1 }).click();
  await expect(root.locator('.cm-content')).toBeFocused();
  await expect(root.locator('.cm-wysiwyg-line .icon-img')).toHaveCount(12);
  await expect(root.locator('.cm-wysiwyg-line strong')).toContainText(['bold']);

  await root.locator('.cm-wysiwyg-line[data-line-number="2"]').click({ position: { x: 4, y: 8 } });
  const raw = root.locator('.cm-line').nth(1);
  await expect(raw).toContainText(original);
  await expect(raw.locator('.cm-sb-icon').first()).toHaveText(`[${target}.icon*3]`);
  // End は折り返した表示行の末尾へ移るため、原文の文字数だけ進める。
  for (let index = 0; index < original.length; index += 1) await page.keyboard.press('ArrowRight');
  await page.keyboard.insertText(' edited');
  const appended = `${original} edited`;
  body[0] = appended;
  await expect.poll(async () => {
    const persisted = await page.request.get(`/api/pages/e2e/${title}`);
    expect(persisted.ok()).toBe(true);
    return (await persisted.json()).lines.map((line: { text: string }) => line.text);
  }).toEqual([title, ...body]);
  await expect(page.locator('#save-status')).toHaveText('保存済み');

  const changed = `通常 [${target}.icon*2] 後 edited`;
  for (let index = 0; index < appended.length; index += 1) await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.insertText(changed);
  body[0] = changed;
  await expect.poll(async () => {
    const persisted = await page.request.get(`/api/pages/e2e/${title}`);
    expect(persisted.ok()).toBe(true);
    return (await persisted.json()).lines.map((line: { text: string }) => line.text);
  }).toEqual([title, ...body]);
  await expect(page.locator('#save-status')).toHaveText('保存済み');
  await root.locator('.cm-line').first().click();
  await expect(root.locator('.cm-wysiwyg-line .icon-img')).toHaveCount(11);
  await expect(root.locator('.cm-wysiwyg-line[data-line-number="2"] .icon-img')).toHaveCount(2);

  await page.reload();
  await expect(root.locator('.line-row').nth(1)).toContainText('後 edited');
  await expect(root.locator('.icon-img')).toHaveCount(11);
  await root.locator('.icon-link').first().click();
  await expect(page).toHaveURL(`/e2e/${target}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(target);
  expect(errors).toEqual([]);
});
