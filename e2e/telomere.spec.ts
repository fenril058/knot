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

test('編集を始めた後も、カーソル行のテロメアには Tab と読み上げで届き、Enter と Space でメニューを開き、閉じるとテロメアへ戻る', async (
  { page },
  testInfo,
) => {
  await loginE2eAccount(page, 'telomere-edit-e2e');
  const title = `telomere-edit-keyboard-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  // 2 行目だけ、更新日時を 1 日後にする。
  const imported = await page.request.post('/api/knot/projects/e2e/import', {
    headers: { 'X-Knot-Client': 'e2e' },
    data: {
      pages: [{
        title,
        created: UPDATED,
        updated: UPDATED + DAY,
        lines: [
          { text: title, created: UPDATED, updated: UPDATED },
          { text: 'first body', created: UPDATED, updated: UPDATED },
          { text: 'second body', created: UPDATED, updated: UPDATED + DAY },
        ],
      }],
    },
  });
  expect(imported.ok()).toBe(true);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/e2e/${title}`);
  const ids = await page.locator('#editor-root .line-row').evaluateAll((rows) => rows.map((row) => row.id.slice(1)));
  await page.locator('#editor-root .line-row').nth(1).click({ position: lineRowClickPosition });
  const content = page.locator('#editor-root .cm-content');
  await expect(content).toBeFocused();

  // CodeMirror は gutter を aria-hidden にするので、カーソル行のテロメアを指す button を gutter の外に置く（#327）。
  // 名前は閲覧表示のテロメアと同じ「<日時>に更新」で、caret を動かすとその行の日時になる。
  const button = page.getByRole('button', { name: /に更新$/ });
  await expect(button).toHaveAccessibleName(UPDATED_LABEL);
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  expect(await button.evaluate((element) => element.closest('[aria-hidden="true"]'))).toBeNull();
  await page.keyboard.press('ArrowDown');
  const secondLabel = '2020/7/23 2:23:18に更新';
  await expect(button).toHaveAccessibleName(secondLabel);

  // mouse は、これまでどおり gutter のテロメアが受ける。押せる幅は閲覧表示と同じ 20px で、高さは行と同じ。
  const gutterTelomere = page.locator('#editor-root .cm-telomere-gutter .telomere').nth(2);
  const gutterBox = (await gutterTelomere.boundingBox())!;
  const lineBox = (await page.locator('#editor-root .cm-line').nth(2).boundingBox())!;
  expect([gutterBox.width, gutterBox.height].map(Math.round)).toEqual([20, Math.round(lineBox.height)]);
  const center = await telomereCenter(gutterTelomere);
  expect(await gutterTelomere.evaluate((element, { x, y }) => document.elementFromPoint(x, y) === element, center)).toBe(true);

  // 本文から Escape で出ると、Tab でカーソル行のテロメアに届き、その枠は gutter のテロメアに重なる。
  await page.keyboard.press('Escape');
  for (let count = 0; count < 20; count += 1) {
    if (await button.evaluate((element) => element === document.activeElement)) break;
    await page.keyboard.press('Tab');
  }
  await expect(button).toBeFocused();
  expect(Object.values((await button.boundingBox())!).map(Math.round)).toEqual(Object.values(gutterBox).map(Math.round));

  // Enter で開くと、行を強調して行へのリンクにし、メニューの最初の項目へ移る。Escape で閉じてテロメアへ戻る。
  const copyLink = page.getByRole('button', { name: 'リンクをコピー', exact: true });
  await page.keyboard.press('Enter');
  await expect(copyLink).toBeFocused();
  await expect(page.locator('.telomere-info > *')).toHaveText([secondLabel, 'リンクをコピー', 'リーダブルリンクをコピー']);
  await expect(page).toHaveURL(new RegExp(`#${ids[2]}$`));
  await expect(page.locator('#editor-root .cm-line.highlight')).toHaveText('second body');
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(page.locator('.telomere-info')).toBeHidden();
  await expect(button).toBeFocused();
  await expect(button).toHaveAttribute('aria-expanded', 'false');

  // Space でも開く。項目を選ぶと、コピーしてメニューを閉じ、テロメアへ戻る。
  await page.keyboard.press('Space');
  await expect(copyLink).toBeFocused();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(`${new URL(page.url()).origin}/e2e/${title}#${ids[2]}`);
  await expect(page.locator('.telomere-info')).toBeHidden();
  await expect(button).toBeFocused();

  // テロメアは本文の前の tab stop で、次の Tab で本文へ移る。
  await page.keyboard.press('Tab');
  await expect(content).toBeFocused();
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

test('行へのリンクで開くと、Cosense と同じく、行が先頭の画面に入っていれば scroll せず、入っていなければ行の上端を 100px に置く', async (
  { page },
  testInfo,
) => {
  await loginE2eAccount(page, 'telomere-e2e');
  const title = `telomere-anchor-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  const ids = await importPage(page, title, Array.from({ length: 60 }, (_, index) => `line ${index}`));
  const path = `/e2e/${encodeURIComponent(title)}`;
  // 行の上端（ページの先頭から）。Cosense は、これに 10px を足して画面の高さ（800px）より上なら、行が先頭の画面に入っていると見る。
  const tops = await page.locator('#editor-root .line-row').evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().top + window.scrollY));
  const inFirstScreen = tops.findLastIndex((top) => top + 10 < 800);
  const belowFirstScreen = inFirstScreen + 1;
  expect(tops[belowFirstScreen]! + 10).toBeGreaterThanOrEqual(800);
  const view = async (index: number): Promise<{ scrollY: number; top: number }> => page.evaluate((id) => ({
    scrollY: window.scrollY,
    top: Math.round(document.getElementById(`L${id}`)!.getBoundingClientRect().top),
  }), ids[index]);

  // 開いたときの画面に入っている行は、scroll せずに強調する。
  await page.goto('about:blank');
  await page.goto(`${path}#${ids[inFirstScreen]}`);
  await expect(page.locator('#editor-root .line-row.highlight')).toHaveId(`L${ids[inFirstScreen]}`);
  expect(await view(inFirstScreen)).toEqual({ scrollY: 0, top: Math.round(tops[inFirstScreen]!) });
  // 入っていない行は、上端を画面の上から 100px に置く。
  await page.goto('about:blank');
  await page.goto(`${path}#${ids[belowFirstScreen]}`);
  await expect(page.locator('#editor-root .line-row.highlight')).toHaveId(`L${ids[belowFirstScreen]}`);
  expect((await view(belowFirstScreen)).top).toBe(100);

  // 同じページの行へのリンクを押したときも、開き直したときと同じ位置にする。下へ scroll した後でも、
  // 先頭の画面に入る行なら先頭へ戻る。
  await page.evaluate(() => window.scrollTo(0, 1000));
  await page.evaluate((id) => { window.location.hash = id; }, ids[inFirstScreen]!);
  await expect(page.locator('#editor-root .line-row.highlight')).toHaveId(`L${ids[inFirstScreen]}`);
  expect(await view(inFirstScreen)).toEqual({ scrollY: 0, top: Math.round(tops[inFirstScreen]!) });
  // 下の行は、上端を画面の上から 100px に置く（ページの末尾に近すぎて、そこまで scroll できない行は選ばない）。
  const below = belowFirstScreen + 10;
  await page.evaluate((id) => { window.location.hash = id; }, ids[below]!);
  await expect(page.locator('#editor-root .line-row.highlight')).toHaveId(`L${ids[below]}`);
  expect((await view(below)).top).toBe(100);
});
