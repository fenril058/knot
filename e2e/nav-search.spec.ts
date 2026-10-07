import { test, expect, type Page } from '@playwright/test';
import { createE2ePage, deferred, lineRowClickPosition, loginE2eAccount } from './helpers.ts';

// 上部のバーの検索欄（#247）。位置と大きさは Cosense の公開ページで測った値。

type Box = { x: number; y: number; width: number; height: number };

// 0.1px 単位へ丸める（Cosense の値も 0.1px 単位で測った）。
function round(value: number): number {
  return Math.round(value * 10) / 10;
}

async function inputBox(page: Page): Promise<Box & { background: string; radius: string }> {
  const measured = await page.locator('.nav-search-input').evaluate((input) => {
    const box = input.getBoundingClientRect();
    const style = getComputedStyle(input);
    return { x: box.x, y: box.y, width: box.width, height: box.height, background: style.backgroundColor, radius: style.borderRadius };
  });
  return { ...measured, x: round(measured.x), y: round(measured.y), width: round(measured.width), height: round(measured.height) };
}

test('上部のバーの検索欄を、ページ・未作成のページ・トップ・結果ページで Cosense と同じ位置と見た目に置く', async ({ page }, testInfo) => {
  await loginE2eAccount(page, 'search-e2e');
  const title = `nav-search-look-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  await createE2ePage(page, title, ['検索欄の位置を測る本文']);

  const paths = [`/e2e/${title}`, `/e2e/${title}-missing`, '/e2e', '/e2e/search/page?q=body'];
  const layouts = [
    { width: 1280, input: { x: 379.4, y: 4, width: 521.1, height: 32 } },
    { width: 800, input: { x: 324.8, y: 4, width: 451.2, height: 32 } },
  ];
  for (const layout of layouts) {
    await page.setViewportSize({ width: layout.width, height: 800 });
    for (const path of paths) {
      await page.goto(path);
      expect({ path, ...(await inputBox(page)) })
        .toEqual({ path, ...layout.input, background: 'rgba(255, 255, 255, 0.5)', radius: '5px' });
    }
  }
});

test('入力するとタイトルの候補を入力欄の下に出し、↓ と Enter で候補のページへ移る', async ({ page }, testInfo) => {
  await loginE2eAccount(page, 'search-e2e');
  const suffix = `${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  const target = `navsearch-candidate-${suffix}`;
  await createE2ePage(page, target, ['候補から開くページ']);
  await createE2ePage(page, `${target}-two`, ['もう 1 つの候補']);
  await createE2ePage(page, `unrelated-${suffix}`, ['候補に出ないページ']);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/e2e/unrelated-${suffix}`);
  const input = page.locator('.nav-search-input');
  await input.click();
  await input.pressSequentially(target);
  const candidates = page.locator('.nav-search-candidates a');
  await expect(candidates).toHaveText([target, `${target}-two`]);
  // 候補の一覧は入力欄の 2px 下に、左を揃えて出る。
  const list = (await page.locator('.nav-search-candidates').boundingBox())!;
  const box = await inputBox(page);
  expect({ x: Math.round(list.x), y: Math.round(list.y) }).toEqual({ x: Math.round(box.x), y: box.y + box.height + 2 });

  await page.keyboard.press('ArrowDown');
  await expect(candidates.first()).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(`/e2e/${target}`);
});

test('Escape で候補を閉じて検索欄から抜け、検索欄への入力では本文の編集を始めない', async ({ page }, testInfo) => {
  await loginE2eAccount(page, 'search-e2e');
  const title = `navsearch-escape-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  await createE2ePage(page, title, ['検索欄から抜けた後も、本文は押せば編集できる']);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/e2e/${title}`);
  const input = page.locator('.nav-search-input');
  await input.click();
  await input.pressSequentially(title);
  await expect(page.locator('.nav-search-candidates a')).toHaveText([title]);
  // 検索欄に入力しても、本文は閲覧表示のまま。
  await expect(page.locator('#editor-root .cm-content')).toHaveCount(0);

  await page.keyboard.press('Escape');
  await expect(page.locator('.nav-search-candidates')).toBeHidden();
  await expect(input).not.toBeFocused();

  // 検索欄の外を押しても候補は閉じる。本文の行を押すと、従来どおり編集を始める。
  await input.click();
  await input.pressSequentially('x');
  await page.locator('#editor-root .line-row').nth(1).click({ position: lineRowClickPosition });
  await expect(page.locator('.nav-search-candidates')).toBeHidden();
  await expect(page.locator('#editor-root .cm-content')).toBeFocused();
});

test('候補を選ばずに Enter を押すと全文検索の結果ページへ移り、語を含むページを語を示して並べる', async ({ page }, testInfo) => {
  await loginE2eAccount(page, 'search-e2e');
  const suffix = `${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  const word = `needleword${suffix}`;
  const title = `navsearch-fulltext-${suffix}`;
  await createE2ePage(page, title, [`本文の途中に ${word} がある行`, '語の無い行']);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/e2e/${title}`);
  const input = page.locator('.nav-search-input');
  await input.click();
  await input.pressSequentially(word);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(`/e2e/search/page?q=${word}`);

  const result = page.locator('.search-result', { hasText: title });
  await expect(result.locator('a')).toHaveAttribute('href', `/e2e/${title}`);
  await expect(result.locator('.search-result-lines')).toHaveText(`本文の途中に ${word} がある行`);
  await expect(result.locator('.search-matched')).toHaveText([word]);
  // 結果ページの検索欄には、検索した語が入っている。
  await expect(page.locator('.nav-search-input')).toHaveValue(word);
});

test('JavaScript が無くても、検索欄から全文検索の結果ページへ移れる', async ({ browser }, testInfo) => {
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await loginE2eAccount(page, 'search-e2e');
  const suffix = `${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  const word = `nojsword${suffix}`;
  await createE2ePage(page, `navsearch-nojs-${suffix}`, [`${word} を含む行`]);

  await page.goto('/e2e');
  await page.locator('.nav-search-input').fill(word);
  await page.locator('.nav-search-input').press('Enter');
  await expect(page).toHaveURL(`/e2e/search/page?q=${word}`);
  await expect(page.locator('.search-result a')).toHaveAttribute('href', `/e2e/navsearch-nojs-${suffix}`);
  await context.close();
});

test('タイトルの一覧の応答が遅れても、最後の入力に対する候補だけを出す', async ({ page }, testInfo) => {
  await loginE2eAccount(page, 'search-e2e');
  const prefix = `race-${testInfo.workerIndex}-${testInfo.repeatEachIndex}-a`;
  await createE2ePage(page, prefix, ['a']);
  await createE2ePage(page, `${prefix}b`, ['ab']);

  // タイトルの一覧の応答を止めておき、入力が進んでから返す。
  const held = deferred();
  await page.route('**/api/pages/e2e/search/titles', async (route) => {
    await held.promise;
    await route.continue();
  });

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/e2e/${prefix}`);
  const input = page.locator('.nav-search-input');
  await input.click();
  // 最初の入力は両方の候補に合い、最後の入力は ...ab だけに合う。
  await input.pressSequentially(prefix);
  await input.pressSequentially('b');
  held.resolve();
  await expect(page.locator('.nav-search-candidates a')).toHaveText([`${prefix}b`]);
});
