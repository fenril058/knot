import { test, expect, type Page } from '@playwright/test';
import { lineRowClickPosition, loginE2eAccount } from './helpers.ts';

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
  const toggle = await box(page, '.related-sort-menu .sort-menu-toggle');
  expect(toggle.x + toggle.width).toBeCloseTo(paper.x + paper.width, 1);
  expect(toggle.y).toBeCloseTo(toolbar.y + 4.8, 1);
  expect({ width: toggle.width, height: toggle.height }).toEqual({ width: 46, height: 35 });
  await expect(page.locator('.related-sort-menu .sort-menu-current')).toHaveText('関連度');
  expect((await box(page, '.related-sort-menu .sort-menu-current')).width).toBe(1);

  // menu は展開ボタンの右端に揃え、行の 2px 下に出す。タブにある並び替えは menu に置かない。
  await page.locator('.related-sort-menu .sort-menu-toggle').click();
  const menu = await box(page, '.related-sort-menu .sort-menu-options');
  // click で scroll した場合に備え、toolbar を測り直す。
  const toolbarAfterClick = await box(page, '.related-toolbar');
  expect(menu.x + menu.width).toBeCloseTo(paper.x + paper.width, 1);
  expect(menu.y).toBeCloseTo(toolbarAfterClick.y + 44, 1);
  expect(menu.width).toBe(160);
  await expect(page.locator('.related-sort-menu .sort-menu-options button:visible')).toHaveText(['作成日時', '最終アクセス', '被リンク数', 'タイトル']);
});

test('991px 以下ではタブを置かず、展開ボタンにいまの並び替えの名前を出す', async ({ page }) => {
  await openRelatedBase(page, 800);
  const paper = await box(page, '.page');
  const toolbar = await box(page, '.related-toolbar');
  await expect(page.locator('.related-sort-tab')).toHaveCount(2);
  await expect(page.locator('.related-sort-tab:visible')).toHaveCount(0);
  const toggle = await box(page, '.related-sort-menu .sort-menu-toggle');
  expect(toggle.x + toggle.width).toBeCloseTo(paper.x + paper.width, 1);
  expect(toggle.y).toBeCloseTo(toolbar.y + 4.8, 1);
  expect((await box(page, '.related-sort-menu .sort-menu-current')).width).toBeGreaterThan(1);
  await page.locator('.related-sort-menu .sort-menu-toggle').click();
  await expect(page.locator('.related-sort-menu .sort-menu-options button:visible'))
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
  await page.locator('.related-sort-menu .sort-menu-toggle').click();
  await page.locator('.related-sort-menu .sort-menu-options button', { hasText: 'タイトル' }).click();
  await expect(page.locator('.related-sort-menu')).not.toHaveAttribute('open');
  const byTitle = [
    ['Links', ['rel-alpha', 'rel-bravo', 'rel-charlie']],
    ['rel-alpha', ['rel-two-yankee', 'rel-two-zulu']],
  ];
  expect(await visibleGroups(page)).toEqual(byTitle);
  expect(await page.locator('.related-sort-tab').evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-pressed'))))
    .toEqual(['false', 'false']);
  await expect(page.locator('.related-sort-menu .sort-menu-current')).toHaveText('タイトル');
  expect((await box(page, '.related-sort-menu .sort-menu-current')).width).toBeGreaterThan(1);

  await page.reload();
  expect(await visibleGroups(page)).toEqual(byTitle);
  await expect(page.locator('.related-sort-menu .sort-menu-current')).toHaveText('タイトル');

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
  const toggle = page.locator('.related-sort-menu .sort-menu-toggle');

  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(menu).toHaveAttribute('open');
  await page.keyboard.press('Escape');
  await expect(menu).not.toHaveAttribute('open');
  await expect(toggle).toBeFocused();

  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await expect(page.locator('.related-sort-menu .sort-menu-options button', { hasText: '作成日時' })).toBeFocused();
  await page.locator('.related-sort-menu .sort-menu-options button', { hasText: 'タイトル' }).focus();
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

// 「New Links」の札の線。札の上端からの位置・高さ・幅と色。
function placeholderLine(offset: number, width: number): { offset: number; height: number; width: number; color: string } {
  return { offset, height: 4, width, color: 'rgb(233, 234, 235)' };
}

test('関連ページの最後に、ページの無いリンク先を Cosense と同じ見た目の「New Links」の行に並べる', async ({ page }) => {
  await openRelatedBase(page, 1280);
  await page.goto('/e2e-related/rel-new');
  expect(await visibleGroups(page)).toEqual([
    ['Links', ['rel-solo']],
    ['New Links', ['rel-nowhere-one', 'rel-nowhere-two']],
  ]);
  const group = page.locator('.related-group[aria-label="New Links"]');
  const look = await group.evaluate((list) => {
    const label = list.querySelector('.relation-label-card');
    const item = list.querySelector('li.new-link');
    if (label === null || item === null) throw new Error('New Links row is missing');
    const top = item.getBoundingClientRect().top;
    return {
      label: { background: getComputedStyle(label).backgroundColor, radius: getComputedStyle(label).borderRadius },
      opacity: getComputedStyle(item).opacity,
      // 札の上端からの位置・高さ・幅と色
      lines: Array.from(item.querySelectorAll('.card-placeholder > span'), (line) => {
        const rect = line.getBoundingClientRect();
        return { offset: Math.round((rect.top - top) * 10) / 10, height: rect.height, width: Math.round(rect.width * 10) / 10, color: getComputedStyle(line).backgroundColor };
      }),
    };
  });
  // 札の幅 146.7px から左右 12px を除いた 122.7px。5 本目はその 70%。
  expect(look).toEqual({
    label: { background: 'rgb(253, 115, 115)', radius: '3px' },
    opacity: '0.5',
    lines: [
      placeholderLine(52, 122.7),
      placeholderLine(64, 122.7),
      placeholderLine(76, 122.7),
      placeholderLine(88, 122.7),
      placeholderLine(100, 85.9),
    ],
  });

  // 絞り込みはタイトルで探し、札はそのページ（まだ無いページ）へのリンク。
  await page.getByRole('searchbox', { name: '関連ページを絞り込む' }).fill('two');
  expect(await visibleGroups(page)).toEqual([['New Links', ['rel-nowhere-two']]]);
  await group.locator('.card', { hasText: 'rel-nowhere-two' }).click();
  await expect(page).toHaveURL('/e2e-related/rel-nowhere-two');
  await expect(page.locator('#editor-root h1.line-title')).toHaveText('rel-nowhere-two');
});

test('ページの無いタイトルは、タイトルの行だけの空のページと、そこへリンクしているページで描く', async ({ page }) => {
  await openRelatedBase(page, 1280);
  const normalPaper = await box(page, '.page');
  await page.goto('/e2e-related/rel-nowhere-one');
  // 紙面はふだんと同じ位置と幅で、タイトルの行だけ。不透明度を下げ、テロメアは未読の太さ（#289）。
  const paper = await box(page, '.page');
  expect({ x: paper.x, y: paper.y, width: paper.width }).toEqual({ x: normalPaper.x, y: normalPaper.y, width: normalPaper.width });
  await expect(page.locator('.page')).toHaveCSS('opacity', '0.7');
  await expect(page.locator('#editor-root .line-row')).toHaveCount(1);
  await expect(page.locator('#editor-root h1.line-title')).toHaveText('rel-nowhere-one');
  const telomere = page.locator('#editor-root .telomere');
  await expect(telomere).toHaveCSS('border-left-width', '10px');
  await expect(telomere).toHaveCSS('border-left-color', 'rgb(137, 163, 255)');
  await expect(page).toHaveTitle('rel-nowhere-one');
  // このタイトルへリンクしているページを、関連ページとして描く。
  expect(await visibleGroups(page)).toEqual([['Links', ['rel-new']]]);
});

test('ページの無いタイトルは、タイトルの行を押して編集を始め、字を書いたときにページができる', async ({ page }, testInfo) => {
  await openRelatedBase(page, 1280);
  const title = `rel-created-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  await page.goto(`/e2e/${title}`);
  const titleRow = page.locator('#editor-root .line-row').first();
  await titleRow.click({ position: lineRowClickPosition });
  await expect(page.locator('#editor-root .cm-content')).toBeFocused();
  await expect(page.locator('#editor-root .cm-line')).toHaveText([title]);

  // 編集を始めただけでは、ページは作られない（#289）。
  await page.reload();
  await expect(page.locator('.page.not-persistent')).toHaveCount(1);

  // 字を書くと、そのタイトルのページができる。
  await titleRow.click({ position: lineRowClickPosition });
  await expect(page.locator('#editor-root .cm-content')).toBeFocused();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('created body');
  await expect(page.locator('#save-status')).toHaveText('保存済み');
  await page.reload();
  await expect(page.locator('.page.not-persistent')).toHaveCount(0);
  await expect(page.locator('#editor-root .line-row')).toHaveText([title, 'created body']);
});
