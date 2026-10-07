import { test, expect, type Locator, type Page } from '@playwright/test';
import { lineRowClickPosition, loginE2eAccount } from './helpers.ts';

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// 経過時間と、Cosense で観測した線の太さ（#239）。境界から十分に離れた経過時間を選ぶ。
const AGES: Array<[number, number]> = [
  [10 * MINUTE, 10],
  [3 * HOUR, 9],
  [12 * HOUR, 8],
  [1 * DAY, 7],
  [2.7 * DAY, 6],
  [12 * DAY, 5],
  [30 * DAY, 4],
  [90 * DAY, 3],
  [200 * DAY, 2],
  [500 * DAY, 1],
];

// 帯の日時を決めるため、時刻帯を固定する。メニューのリンクのコピーは clipboard を読んで確かめる。
test.use({ timezoneId: 'Asia/Tokyo', permissions: ['clipboard-read', 'clipboard-write'] });

// 日本時間の 2020/7/22 2:23:18。Cosense は時を 0 で埋めないので、1 桁の時を選ぶ。
const UPDATED = Date.UTC(2020, 6, 21, 17, 23, 18) / 1000;
const UPDATED_LABEL = '2020/7/22 2:23:18に更新';

type TelomereLook = { width: string; color: string };

// 行ごとのテロメアの線。閲覧表示では行の中、編集表示では gutter にある。
async function telomeres(page: Page): Promise<TelomereLook[]> {
  return page.locator('#editor-root .telomere').evaluateAll((elements) => elements.map((element) => {
    const style = getComputedStyle(element);
    return { width: style.borderLeftWidth, color: style.borderLeftColor };
  }));
}

test('テロメアは行の経過時間に応じた太さの線で、未読と既読を Cosense と同じ色で描き、編集を始めても変えない', async (
  { page },
  testInfo,
) => {
  await loginE2eAccount(page, 'telomere-e2e');
  const title = `telomere-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  const now = Math.floor(Date.now() / 1000);
  // 行の更新時刻を持ったまま作れるのは import だけなので、Cosense の export の形で取り込む。
  const imported = await page.request.post('/api/knot/projects/e2e/import', {
    headers: { 'X-Knot-Client': 'e2e' },
    data: {
      pages: [{
        title,
        created: now - 600 * DAY,
        updated: now - 10 * MINUTE,
        lines: AGES.map(([age], index) => ({
          text: index === 0 ? title : `line ${index}`,
          created: now - age,
          updated: now - age,
        })),
      }],
    },
  });
  expect(imported.ok()).toBe(true);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/e2e/${title}`);
  const unread = 'rgb(137, 163, 255)';
  const expectedUnread = AGES.map(([, width]) => ({ width: `${width}px`, color: unread }));
  // 初めて開いたページの行はすべて未読。
  expect(await telomeres(page)).toEqual(expectedUnread);

  await page.locator('#editor-root .line-row').nth(AGES.length - 1).click({ position: lineRowClickPosition });
  await expect(page.locator('#editor-root .cm-content')).toBeFocused();
  expect(await telomeres(page)).toEqual(expectedUnread);

  // もう一度開くと、前回から更新されていない行は既読になる。
  await page.reload();
  expect(await telomeres(page)).toEqual(AGES.map(([, width]) => ({ width: `${width}px`, color: 'rgb(226, 226, 226)' })));
});

// 行の更新時刻を持ったまま作れるのは import だけなので、Cosense の export の形で取り込む。
async function importPage(page: Page, title: string, texts: string[]): Promise<string[]> {
  const imported = await page.request.post('/api/knot/projects/e2e/import', {
    headers: { 'X-Knot-Client': 'e2e' },
    data: {
      pages: [{
        title,
        created: UPDATED,
        updated: UPDATED,
        lines: [title, ...texts].map((text) => ({ text, created: UPDATED, updated: UPDATED })),
      }],
    },
  });
  expect(imported.ok()).toBe(true);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/e2e/${encodeURIComponent(title)}`);
  // 行の ID は行の要素の id（L<行の ID>）から読む。
  return page.locator('#editor-root .line-row').evaluateAll((rows) => rows.map((row) => row.id.slice(1)));
}

// hover で出る帯はテロメアに重なり、Playwright の hover と click は帯に遮られたと見て待ち続ける。
// 人と同じく座標で動かし、帯ごと押す（帯を押すとテロメアを押したことになる）。
async function telomereCenter(telomere: Locator): Promise<{ x: number; y: number }> {
  const box = (await telomere.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function hoverTelomere(page: Page, telomere: Locator): Promise<void> {
  const { x, y } = await telomereCenter(telomere);
  await page.mouse.move(x, y);
}

async function clickTelomere(page: Page, telomere: Locator): Promise<void> {
  const { x, y } = await telomereCenter(telomere);
  await page.mouse.click(x, y);
}

async function clipboard(page: Page): Promise<Record<string, string>> {
  return page.evaluate(async () => {
    const result: Record<string, string> = {};
    for (const item of await navigator.clipboard.read()) {
      for (const type of item.types) result[type] = await (await item.getType(type)).text();
    }
    return result;
  });
}

test('テロメアに hover すると Cosense と同じ帯で更新日時を出し、押すと行を強調して行へのリンクのメニューを出す', async (
  { page },
  testInfo,
) => {
  await loginE2eAccount(page, 'telomere-e2e');
  const title = `テロメアのメニュー-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  const ids = await importPage(page, title, ['first body', 'second body']);
  const row = page.locator('#editor-root .line-row').nth(1);
  const telomere = row.locator('.telomere');

  // hover では、テロメアの左端から 2px 右に、幅 160px・高さ 28px の帯で「<日時>に更新」を出す（#173）。
  await hoverTelomere(page, telomere);
  const band = page.locator('.telomere-updated');
  await expect(band).toHaveText(UPDATED_LABEL);
  const telomereBox = (await telomere.boundingBox())!;
  const bandBox = (await band.boundingBox())!;
  expect([bandBox.x - telomereBox.x, bandBox.y - telomereBox.y, bandBox.width, bandBox.height].map(Math.round))
    .toEqual([2, 0, 160, 28]);
  expect(await band.evaluate((element) => {
    const style = getComputedStyle(element);
    return [style.backgroundColor, style.color, style.fontSize, style.lineHeight];
  })).toEqual(['rgb(128, 139, 140)', 'rgb(255, 255, 255)', '12px', '28px']);
  await expect(page.locator('.telomere-menu-item')).toHaveCount(0);
  await page.mouse.move(640, 700);
  await expect(band).toBeHidden();

  // 押すと、行を強調し、URL を行へのリンク（#<行の ID>）にして、帯の下にメニューを出す。編集は始めない。
  await clickTelomere(page, telomere);
  await expect(page).toHaveURL(new RegExp(`#${ids[1]}$`));
  await expect(row).toHaveClass(/\bhighlight\b/);
  await expect(telomere).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.telomere-info > *')).toHaveText([UPDATED_LABEL, 'リンクをコピー', 'リーダブルリンクをコピー']);
  await expect(page.locator('#editor-root .cm-editor')).toHaveCount(0);
  // マウスで押したときは、キーボードで開いたときと違ってメニューへ focus を移さない。
  await expect(page.locator('.telomere-menu-item').first()).not.toBeFocused();

  // Cosense と同じく、テキストには「タイトル URL」、HTML には「タイトル#行の ID」の文字のリンクを書く。
  const href = `${new URL(page.url()).origin}/e2e/${encodeURIComponent(title)}#${ids[1]}`;
  await page.getByRole('button', { name: 'リンクをコピー', exact: true }).click();
  await expect(page.locator('.telomere-info')).toBeHidden();
  await expect.poll(() => clipboard(page)).toEqual({
    'text/plain': `${title} ${href}`,
    'text/html': `<a href="${href}">${title}#${ids[1]}</a>`,
  });

  // リーダブルリンクは、タイトルを percent-encode しない。
  await clickTelomere(page, telomere);
  await page.getByRole('button', { name: 'リーダブルリンクをコピー' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(`${new URL(page.url()).origin}/e2e/${title}#${ids[1]}`);

  // 別の行のテロメアを押すと、強調はその行へ移る。
  await clickTelomere(page, page.locator('#editor-root .line-row').nth(2).locator('.telomere'));
  await expect(page.locator('#editor-root .line-row.highlight')).toHaveId(`L${ids[2]}`);
  // メニューの外を押すと閉じる。
  await page.mouse.click(640, 700);
  await expect(page.locator('.telomere-info')).toBeHidden();
});

test('テロメアは Tab と上下の矢印で選び、Enter と Space でメニューを開き、Escape と Tab で閉じる', async (
  { page },
  testInfo,
) => {
  await loginE2eAccount(page, 'telomere-e2e');
  const title = `telomere-keyboard-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  await importPage(page, title, ['first [link one]', 'second body']);
  const buttons = page.locator('#editor-root .line-row > .telomere');
  const copyLink = page.getByRole('button', { name: 'リンクをコピー', exact: true });
  // 読み上げの名前は、帯と同じ「<日時>に更新」。
  await expect(buttons.nth(1)).toHaveAccessibleName(UPDATED_LABEL);

  // 行のテロメアは 1 つの tab stop で、Tab で先頭の行のテロメアに届く。
  for (let count = 0; count < 20; count += 1) {
    if (await buttons.first().evaluate((element) => element === document.activeElement)) break;
    await page.keyboard.press('Tab');
  }
  await expect(buttons.first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(buttons.nth(1)).toBeFocused();
  expect(await buttons.evaluateAll((elements) => elements.map((element) => element.getAttribute('tabindex'))))
    .toEqual(['-1', '0', '-1']);

  // Enter で開くと、メニューの最初の項目へ移る。Escape で閉じてテロメアへ戻る。
  await page.keyboard.press('Enter');
  await expect(copyLink).toBeFocused();
  await expect(page.locator('#editor-root .line-row').nth(1)).toHaveClass(/\bhighlight\b/);
  await page.keyboard.press('Escape');
  await expect(page.locator('.telomere-info')).toBeHidden();
  await expect(buttons.nth(1)).toBeFocused();
  await expect(buttons.nth(1)).toHaveAttribute('aria-expanded', 'false');

  // Space でも開く。Shift+Tab で前へ出るとテロメアへ戻る。
  await page.keyboard.press('Space');
  await expect(copyLink).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('.telomere-info')).toBeHidden();
  await expect(buttons.nth(1)).toBeFocused();

  // 最後の項目から Tab で後ろへ出ると、テロメアの次の要素（その行のリンク）へ進む。
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'リーダブルリンクをコピー' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('.telomere-info')).toBeHidden();
  // 関連ページの「New Links」の札にも同じ名前のリンクがあるので、本文の中で探す。
  await expect(page.locator('#editor-root').getByRole('link', { name: 'link one' })).toBeFocused();
  await expect(page.locator('#editor-root .cm-editor')).toHaveCount(0);
});

test('行へのリンクで開いた行は編集を始めても強調したままで、編集中も gutter のテロメアから更新日時とメニューに届く', async (
  { page },
  testInfo,
) => {
  await loginE2eAccount(page, 'telomere-e2e');
  const title = `telomere-gutter-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  const ids = await importPage(page, title, ['first body', 'second body', 'third body']);

  // 行へのリンク（Cosense と同じ #<行の ID>）で開くと、その行を強調する。
  await page.goto(`/e2e/${encodeURIComponent(title)}#${ids[2]}`);
  await expect(page.locator('#editor-root .line-row.highlight')).toHaveId(`L${ids[2]}`);
  await page.locator('#editor-root .line-row').nth(1).click({ position: lineRowClickPosition });
  await expect(page.locator('#editor-root .cm-content')).toBeFocused();
  await expect(page.locator('#editor-root .cm-line.highlight')).toHaveText('second body');

  // 編集中の gutter のテロメアも、hover で帯を出し、押すと行を強調してメニューを出す（#195）。
  const gutterTelomere = page.locator('#editor-root .cm-telomere-gutter .telomere').nth(3);
  await hoverTelomere(page, gutterTelomere);
  await expect(page.locator('.telomere-updated')).toHaveText(UPDATED_LABEL);
  await clickTelomere(page, gutterTelomere);
  await expect(page).toHaveURL(new RegExp(`#${ids[3]}$`));
  await expect(page.locator('#editor-root .cm-line.highlight')).toHaveText('third body');
  await expect(page.locator('.telomere-info > *')).toHaveText([UPDATED_LABEL, 'リンクをコピー', 'リーダブルリンクをコピー']);
  await page.getByRole('button', { name: 'リーダブルリンクをコピー' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(`${new URL(page.url()).origin}/e2e/${title}#${ids[3]}`);
  await expect(page.locator('#editor-root .cm-editor')).toHaveCount(1);
});
