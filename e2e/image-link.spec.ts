import { test, expect, type Page } from '@playwright/test';
import { createE2ePage, lineRowClickPosition, loginE2eAccount } from './helpers.ts';

// 本文の画像を押したときの dialog（Cosense の .full-content-modal、#319）。画像は外部ホストなので SVG で代える。
const SIZES: Record<string, [number, number]> = { '/wide.png': [1600, 400], '/small.png': [200, 100] };
const BODY = ['[https://i.gyazo.com/wide.png]', '[https://i.gyazo.com/small.png]', 'last body'];

function svg(width: number, height: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#89a"/></svg>`;
}

// 画像の新しいタブも同じ SVG を受け取るように、context に route を置く。
async function openImagePage(page: Page, title: string): Promise<void> {
  await page.context().route('https://i.gyazo.com/**', (route) => {
    const [width, height] = SIZES[new URL(route.request().url()).pathname] ?? [10, 10];
    return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: svg(width, height) });
  });
  await createE2ePage(page, title, BODY);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/e2e/${title}`);
  await page.waitForFunction(() => Array.from(
    document.querySelectorAll<HTMLImageElement>('#editor-root img:not(.cm-widgetBuffer)'),
    (image) => image.complete && image.naturalWidth > 0,
  ).every(Boolean));
}

test('本文の画像を押すと、Cosense と同じく画像を大きく出す dialog を開き、その行の編集は始めない', async ({ page }, testInfo) => {
  await loginE2eAccount(page, 'image-e2e');
  await openImagePage(page, `image-modal-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`);
  const bodyImage = page.locator('#editor-root .line-row').nth(1).locator('img');
  // 画像の表示幅は本文の幅（862px）いっぱいで、画像の行に行末の余白を付けない。
  expect((await bodyImage.boundingBox())!.width).toBe(862);
  await expect(page.locator('#editor-root .line-row').nth(1)).not.toHaveClass(/link-only/);

  const dialog = page.locator('dialog.image-modal');
  const dialogImage = dialog.locator('img');
  await bodyImage.click();
  await expect(dialog).toBeVisible();
  // 画像は画面の中央に、95vw から余白（15px × 2）を引いた幅まで広げて出す。背景は黒の 80%。
  expect(await dialogImage.evaluate((image) => {
    const { x, width } = image.getBoundingClientRect();
    return { src: image.getAttribute('src'), x, width, backdrop: getComputedStyle(image.closest('dialog')!, '::backdrop').backgroundColor };
  })).toEqual({ src: 'https://i.gyazo.com/wide.png', x: 47, width: 1186, backdrop: 'rgba(0, 0, 0, 0.8)' });
  await expect(dialog.locator('a')).toHaveAttribute('href', 'https://i.gyazo.com/wide.png');
  await expect(dialog.locator('a')).toHaveAttribute('target', '_blank');
  await expect(page.locator('#editor-root .cm-editor')).toHaveCount(0);

  // Escape と背景で閉じる。
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await bodyImage.click();
  await expect(dialog).toBeVisible();
  await page.mouse.click(10, 10);
  await expect(dialog).toBeHidden();

  // dialog の中の画像を押すと、新しいタブで画像を開いて閉じる。
  await bodyImage.click();
  const popup = page.context().waitForEvent('page');
  await dialogImage.click();
  await (await popup).waitForURL('https://i.gyazo.com/wide.png');
  await expect(dialog).toBeHidden();

  // ctrl（cmd）を押しながらの click は、dialog を開かずに新しいタブで開く。
  // Chromium の背景タブは読み込み前だと Playwright の page イベントが届かないので、
  // CDP のページ target が増えたことを見る。
  const cdp = await page.context().newCDPSession(page);
  const { targetInfos: before } = await cdp.send('Target.getTargets');
  const previousPageIds = new Set(before.filter((target) => target.type === 'page').map((target) => target.targetId));
  await bodyImage.click({ modifiers: ['ControlOrMeta'] });
  await expect.poll(async () => {
    const { targetInfos } = await cdp.send('Target.getTargets');
    return targetInfos.filter((target) => target.type === 'page' && !previousPageIds.has(target.targetId)).length;
  }).toBe(1);
  await cdp.detach();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#editor-root .cm-editor')).toHaveCount(0);
});

test('画像の行は、画像の外から編集を始められ、テロメアを押したときの振る舞いは変わらない', async ({ page }, testInfo) => {
  await loginE2eAccount(page, 'image-e2e');
  await openImagePage(page, `image-edit-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`);
  const dialog = page.locator('dialog.image-modal');
  const row = page.locator('#editor-root .line-row').nth(1);

  // テロメアを押すと、これまでどおり更新日時と行へのリンクのメニューを出す。
  const telomere = (await row.locator('> .telomere').boundingBox())!;
  await page.mouse.click(telomere.x + telomere.width / 2, telomere.y + 10);
  await expect(page.locator('.telomere-info')).toBeVisible();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#editor-root .cm-editor')).toHaveCount(0);
  // メニューは外（紙面の左の、本文の外）を押すと閉じる。
  await page.mouse.click(60, 400);
  await expect(page.locator('.telomere-info')).toBeHidden();
  await expect(page.locator('#editor-root .cm-editor')).toHaveCount(0);

  // 紙面の左の余白（テロメアの右）を押すと、その行の編集を始める。
  await row.click({ position: lineRowClickPosition });
  await expect(page.locator('#editor-root .cm-content')).toBeFocused();
  await expect(page.locator('#editor-root .cm-line').nth(1)).toHaveText(BODY[0]!);

  // 編集表示の整形表示の行でも、画像を押すと dialog を出し、caret は動かさない。
  const widgetImage = page.locator('#editor-root .cm-line').nth(2).locator('img:not(.cm-widgetBuffer)');
  expect((await widgetImage.boundingBox())!.width).toBe(200);
  await widgetImage.click();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('img')).toHaveAttribute('src', 'https://i.gyazo.com/small.png');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.locator('#editor-root .cm-line').nth(1)).toHaveText(BODY[0]!);
  // 画像の右の空きを押すと、その行に caret を置く。
  await page.locator('#editor-root .cm-line').nth(2).click({ position: { x: 600, y: 50 } });
  await expect(page.locator('#editor-root .cm-line').nth(2)).toHaveText(BODY[1]!);
  await expect(dialog).toBeHidden();
});
