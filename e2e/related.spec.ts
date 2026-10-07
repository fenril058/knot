import { test, expect, type Page } from '@playwright/test';
import { loginE2eAccount } from './helpers.ts';

// 関連ページの絞り込み欄と並び替え（#281）。ページは e2e/server.ts が e2e-related に用意する。

type Box = { x: number; y: number; width: number; height: number };

async function box(page: Page, selector: string): Promise<Box> {
  const found = await page.locator(selector).first().boundingBox();
  if (found === null) throw new Error(`${selector} is not visible`);
  return found;
}

// 見えている行の見出しと、その行の見えている札のタイトル。
async function visibleGroups(page: Page): Promise<[string, string[]][]> {
  return page.locator('.related-group').evaluateAll((lists) => lists
    .filter((list) => list.getBoundingClientRect().height > 0)
    .map((list): [string, string[]] => [
      list.getAttribute('aria-label') ?? '',
      Array.from(list.querySelectorAll(':scope > li:not(.relation-label)'))
        .filter((item) => item.getBoundingClientRect().height > 0)
        .map((item) => item.querySelector('h3')?.textContent ?? ''),
    ]));
}

async function openRelatedBase(page: Page, width: number): Promise<void> {
  await loginE2eAccount(page, 'related-e2e');
  await page.setViewportSize({ width, height: 800 });
  await page.goto('/e2e-related/rel-base');
}

test('関連ページの行の上に、Cosense と同じ位置と大きさの絞り込み欄と並び替えを置く', async ({ page }) => {
  await openRelatedBase(page, 1280);
  const paper = await box(page, '.page');
  const toolbar = await box(page, '.related-toolbar');
  // 紙面の 24px 下に高さ 42px の toolbar、その 16px 下から最初の行。
  expect(toolbar.y).toBeCloseTo(paper.y + paper.height + 24, 1);
  expect(toolbar).toMatchObject({ x: paper.x, width: paper.width, height: 42 });
  expect(await box(page, '.related-filter')).toEqual({ x: paper.x, y: toolbar.y, width: 400, height: 32 });
  expect((await box(page, '.relation-label')).y).toBeCloseTo(toolbar.y + 42 + 16, 1);
  // 右端にタブ（高さ 31px、行の中央）と、上から 4.8px の展開ボタン（46 × 35px）。
  const tabs = await page.locator('.related-sort-tab').evaluateAll((buttons, toolbarTop) => buttons.map((button) => {
    const rect = button.getBoundingClientRect();
    return { text: button.textContent, offset: Math.round((rect.top - toolbarTop) * 10) / 10, height: rect.height };
  }), toolbar.y);
  expect(tabs).toEqual([
    { text: '関連度', offset: 5.5, height: 31 },
    { text: '更新日時', offset: 5.5, height: 31 },
  ]);
  const toggle = await box(page, '.related-sort-toggle');
  expect(toggle.x + toggle.width).toBeCloseTo(paper.x + paper.width, 1);
  expect(toggle.y).toBeCloseTo(toolbar.y + 4.8, 1);
  expect({ width: toggle.width, height: toggle.height }).toEqual({ width: 46, height: 35 });
  await expect(page.locator('.related-sort-current')).toHaveText('関連度');
  expect((await box(page, '.related-sort-current')).width).toBe(1);

  // menu は展開ボタンの右端に揃え、行の 2px 下に出す。タブにある並び替えは menu に置かない。
  await page.locator('.related-sort-toggle').click();
  const menu = await box(page, '.related-sort-options');
  // click で scroll した場合に備え、toolbar を測り直す。
  const toolbarAfterClick = await box(page, '.related-toolbar');
  expect(menu.x + menu.width).toBeCloseTo(paper.x + paper.width, 1);
  expect(menu.y).toBeCloseTo(toolbarAfterClick.y + 44, 1);
  expect(menu.width).toBe(160);
  await expect(page.locator('.related-sort-options button:visible')).toHaveText(['作成日時', '最終アクセス', '被リンク数', 'タイトル']);
});

test('991px 以下ではタブを置かず、展開ボタンにいまの並び替えの名前を出す', async ({ page }) => {
  await openRelatedBase(page, 800);
  const paper = await box(page, '.page');
  const toolbar = await box(page, '.related-toolbar');
  await expect(page.locator('.related-sort-tab')).toHaveCount(2);
  await expect(page.locator('.related-sort-tab:visible')).toHaveCount(0);
  const toggle = await box(page, '.related-sort-toggle');
  expect(toggle.x + toggle.width).toBeCloseTo(paper.x + paper.width, 1);
  expect(toggle.y).toBeCloseTo(toolbar.y + 4.8, 1);
  expect((await box(page, '.related-sort-current')).width).toBeGreaterThan(1);
  await page.locator('.related-sort-toggle').click();
  await expect(page.locator('.related-sort-options button:visible'))
    .toHaveText(['関連度', '更新日時', '作成日時', '最終アクセス', '被リンク数', 'タイトル']);
});

test('並び替えは行の並びを変えずに各行の中の札を並べ替え、選んだ並び替えをブラウザに残す', async ({ page }) => {
  await openRelatedBase(page, 1280);
  expect(await visibleGroups(page)).toEqual([
    ['Links', ['rel-bravo', 'rel-alpha', 'rel-charlie']],
    ['rel-alpha', ['rel-two-zulu', 'rel-two-yankee']],
  ]);

  await page.locator('.related-sort-tab', { hasText: '更新日時' }).click();
  expect(await visibleGroups(page)).toEqual([
    ['Links', ['rel-alpha', 'rel-charlie', 'rel-bravo']],
    ['rel-alpha', ['rel-two-zulu', 'rel-two-yankee']],
  ]);
  expect(await page.locator('.related-sort-tab').evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-pressed'))))
    .toEqual(['false', 'true']);

  // menu の並び替えを選ぶと menu を閉じ、どちらのタブも選んでいない見た目にして、展開ボタンに名前を出す。
  await page.locator('.related-sort-toggle').click();
  await page.locator('.related-sort-options button', { hasText: 'タイトル' }).click();
  await expect(page.locator('.related-sort-menu')).not.toHaveAttribute('open');
  const byTitle = [
    ['Links', ['rel-alpha', 'rel-bravo', 'rel-charlie']],
    ['rel-alpha', ['rel-two-yankee', 'rel-two-zulu']],
  ];
  expect(await visibleGroups(page)).toEqual(byTitle);
  expect(await page.locator('.related-sort-tab').evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-pressed'))))
    .toEqual(['false', 'false']);
  await expect(page.locator('.related-sort-current')).toHaveText('タイトル');
  expect((await box(page, '.related-sort-current')).width).toBeGreaterThan(1);

  await page.reload();
  expect(await visibleGroups(page)).toEqual(byTitle);
  await expect(page.locator('.related-sort-current')).toHaveText('タイトル');

  await page.locator('.related-sort-tab', { hasText: '関連度' }).click();
  expect(await visibleGroups(page)).toEqual([
    ['Links', ['rel-bravo', 'rel-alpha', 'rel-charlie']],
    ['rel-alpha', ['rel-two-zulu', 'rel-two-yankee']],
  ]);
  // 並べ替えた札も、押せばそのページへ移る。
  await page.locator('.related-group .card', { hasText: 'rel-charlie' }).click();
  await expect(page).toHaveURL('/e2e-related/rel-charlie');
});

test('絞り込みは語をすべて含む札だけを残し、札の残らない行を隠す', async ({ page }) => {
  await openRelatedBase(page, 1280);
  const input = page.getByRole('searchbox', { name: '関連ページを絞り込む' });

  // 説明文の語でも残す。
  await input.fill('needle');
  expect(await visibleGroups(page)).toEqual([['Links', ['rel-charlie']]]);

  // 空白（全角も）で区切った語をすべて含む札だけ。大文字と小文字は区別しない。
  await input.fill('REL-TWO　yankee');
  expect(await visibleGroups(page)).toEqual([['rel-alpha', ['rel-two-yankee']]]);

  // 絞り込んだまま並べ替えても、残す札は変わらない。
  await input.fill('rel-');
  await page.locator('.related-sort-tab', { hasText: '更新日時' }).click();
  await input.fill('rel-a');
  expect(await visibleGroups(page)).toEqual([
    ['Links', ['rel-alpha']],
    ['rel-alpha', ['rel-two-zulu', 'rel-two-yankee']],
  ]);

  await input.fill('');
  expect(await visibleGroups(page)).toEqual([
    ['Links', ['rel-alpha', 'rel-charlie', 'rel-bravo']],
    ['rel-alpha', ['rel-two-zulu', 'rel-two-yankee']],
  ]);
});

test('並び替えの menu はキーボードで開いて選べ、Escape と menu の外を押すと閉じる', async ({ page }) => {
  await openRelatedBase(page, 1280);
  const menu = page.locator('.related-sort-menu');
  const toggle = page.locator('.related-sort-toggle');

  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(menu).toHaveAttribute('open');
  await page.keyboard.press('Escape');
  await expect(menu).not.toHaveAttribute('open');
  await expect(toggle).toBeFocused();

  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await expect(page.locator('.related-sort-options button', { hasText: '作成日時' })).toBeFocused();
  await page.locator('.related-sort-options button', { hasText: 'タイトル' }).focus();
  await page.keyboard.press('Enter');
  await expect(menu).not.toHaveAttribute('open');
  await expect(toggle).toBeFocused();
  expect((await visibleGroups(page))[0]).toEqual(['Links', ['rel-alpha', 'rel-bravo', 'rel-charlie']]);

  await toggle.click();
  await expect(menu).toHaveAttribute('open');
  const paper = await box(page, '.page');
  await page.mouse.click(paper.x + paper.width / 2, paper.y + paper.height + 10);
  await expect(menu).not.toHaveAttribute('open');
});
