import { test, expect, type Page } from '@playwright/test';
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
