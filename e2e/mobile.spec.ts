import { test, expect, type Page, type Response } from '@playwright/test';
import {
  createE2ePage,
  expectSameTextBox,
  firstRectCenter,
  firstVisualLineLength,
  indentMarks,
  lineTextBoxes,
  linkRowTargets,
  loginE2eAccount,
  loginProjectE2e,
  loginTitleE2e,
  pageGeometry,
  rowHeights,
  scrollRowTo,
  textStyleOf,
  visibleTitleCount,
  visualLineRects,
} from './helpers.ts';

const expectedViewportWidths: Record<string, number> = {
  'mobile-chromium': 360,
  'mobile-webkit': 393,
};

async function expectMobileLayout(target: Page, expectedWidth: number): Promise<void> {
  const dimensions = await target.evaluate(() => ({
    innerWidth: window.innerWidth,
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.innerWidth).toBe(expectedWidth);
  expect(dimensions.clientWidth).toBe(expectedWidth);
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(expectedWidth);
}

function hasLineUpdate(body: unknown, lineId: string, text: string): boolean {
  if (typeof body !== 'object' || body === null || !('ops' in body) || !Array.isArray(body.ops)) return false;
  return body.ops.some((op: unknown) =>
    typeof op === 'object'
    && op !== null
    && 'type' in op
    && op.type === 'update'
    && 'id' in op
    && op.id === lineId
    && 'text' in op
    && op.text === text
  );
}

function isSuccessfulCommitWithLineUpdate(
  response: Response,
  commitUrl: string,
  lineId: string,
  text: string,
): boolean {
  if (
    !response.url().endsWith(commitUrl)
    || response.request().method() !== 'POST'
    || !response.ok()
  ) return false;

  try {
    return hasLineUpdate(response.request().postDataJSON(), lineId, text);
  } catch {
    return false;
  }
}

test('mobile browser でページを探して編集し、再読み込み後も内容が残る', async ({ page }, testInfo) => {
  const expectedWidth = expectedViewportWidths[testInfo.project.name];
  if (expectedWidth === undefined) throw new Error(`unexpected mobile project: ${testInfo.project.name}`);
  await loginProjectE2e(page);

  const title = `mobile-basic-flow-${testInfo.project.name}-${testInfo.repeatEachIndex}`;
  const created = await page.request.post(`/api/knot/pages/e2e/${title}/commits`, {
    headers: { 'X-Knot-Client': 'e2e' },
    data: {
      commitId: `${title}-create`,
      baseVersion: 0,
      ops: [
        { type: 'insert', id: `${title}-title`, after: '_head', text: title },
        {
          type: 'insert',
          id: `${title}-existing`,
          after: `${title}-title`,
          text: '変更前の既存行',
        },
      ],
    },
  });
  expect(created.ok()).toBe(true);

  await page.goto('/');
  await expectMobileLayout(page, expectedWidth);
  const projectLink = page.getByRole('link', { name: 'e2e', exact: true });
  await expect(projectLink).toBeInViewport();
  await projectLink.tap();
  await expect(page).toHaveURL('/e2e');
  // 検索も編集開始も module script が listener を付けてから効く。toHaveURL は読み込みを
  // 待たないので、遷移直後に操作すると listener が付く前の入力が捨てられる。
  await page.waitForLoadState();
  await expectMobileLayout(page, expectedWidth);

  const search = page.getByRole('searchbox');
  await expect(search).toBeInViewport();
  const fullTextSearch = page.waitForResponse((response) =>
    response.url().includes(`/api/pages/e2e/search/query?q=${title}`)
    && response.ok()
  );
  await search.fill(title);
  await fullTextSearch;
  const searchHit = page.locator(`#search-results a.search-hit[href="/e2e/${title}"]`);
  await expect(searchHit).toHaveText(`${title}: ${title}`);
  await expect(searchHit).toBeVisible();
  await expect(searchHit).toBeInViewport();
  await searchHit.tap();
  await expect(page).toHaveURL(`/e2e/${title}`);
  await page.waitForLoadState();
  await expectMobileLayout(page, expectedWidth);
  await expect(page.locator('.page-body')).toContainText('変更前の既存行');
  await expect(page.getByRole('button', { name: '編集', exact: true })).toHaveCount(0);

  const existingSsrLine = page.locator('.page-body .line-row').nth(1);
  await expect(existingSsrLine).toBeInViewport();
  await existingSsrLine.tap();
  const editor = page.locator('#editor-root .cm-content');
  await expect(editor).toBeFocused();
  await expect(editor).toBeInViewport();
  await expectMobileLayout(page, expectedWidth);

  const finalLineText = 'mobile で変更した既存行';
  const finalDocument = [title, finalLineText, 'mobile で追加した行'];
  const finalSaveResponse = page.waitForResponse((response) =>
    isSuccessfulCommitWithLineUpdate(
      response,
      `/api/knot/pages/e2e/${title}/commits`,
      `${title}-existing`,
      finalLineText,
    )
  );
  const activeExistingLine = page.locator('#editor-root .cm-line').nth(1);
  await expect(activeExistingLine).toContainText('変更前の既存行');
  await expect(activeExistingLine).toBeInViewport();
  await page.keyboard.press('End');
  // Playwright does not open a software keyboard; insertText dispatches the input event
  // that adds the newline and text to CodeMirror's contenteditable element.
  await page.keyboard.insertText('\nmobile で追加した行');
  await expect(page.locator('#editor-root .cm-line')).toHaveText([
    title,
    '変更前の既存行',
    'mobile で追加した行',
  ]);
  const existingLine = page.locator('.cm-wysiwyg-line[data-line-number="2"]');
  await expect(existingLine).toBeInViewport();
  await existingLine.tap();
  await expect(editor).toBeFocused();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
  await page.keyboard.insertText(finalLineText);

  // The existing-line update is the last user mutation. SyncEngine sends one
  // commit at a time, so its successful response also follows any split insert.
  await finalSaveResponse;
  await expect(page.locator('#save-status')).toHaveText('保存済み');
  await expect(page.locator('#editor-root .cm-line')).toHaveText(finalDocument);
  const persisted = await page.request.get(`/api/pages/e2e/${title}`);
  expect(persisted.ok()).toBe(true);
  expect((await persisted.json()).lines.map((line: { text: string }) => line.text)).toEqual(finalDocument);

  await page.reload();
  await expectMobileLayout(page, expectedWidth);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);
  await expect(page.locator('.page-body .line-row')).toHaveText([
    title,
    'mobile で変更した既存行',
    'mobile で追加した行',
  ]);
});

test('mobile browser は見えているタイトルの tap から title 行の編集に入る', async ({ page }, testInfo) => {
  const expectedWidth = expectedViewportWidths[testInfo.project.name];
  if (expectedWidth === undefined) throw new Error(`unexpected mobile project: ${testInfo.project.name}`);
  await loginTitleE2e(page);

  const title = `mobile-title-tap-${testInfo.project.name}-${testInfo.repeatEachIndex}`;
  const created = await page.request.post(`/api/knot/pages/e2e/${title}/commits`, {
    headers: { 'X-Knot-Client': 'e2e' },
    data: {
      commitId: `${title}-create`,
      baseVersion: 0,
      ops: [
        { type: 'insert', id: `${title}-title`, after: '_head', text: title },
        { type: 'insert', id: `${title}-existing`, after: `${title}-title`, text: 'mobile の本文' },
      ],
    },
  });
  expect(created.ok()).toBe(true);

  await page.goto(`/e2e/${title}`);
  await expectMobileLayout(page, expectedWidth);
  const heading = page.getByRole('heading', { level: 1 });
  await expect(heading).toHaveText(title);
  await expect(heading).toBeInViewport();
  expect(await visibleTitleCount(page, title)).toBe(1);

  await heading.tap();
  await expect(page.locator('#editor-root .cm-content')).toBeFocused();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);
  await expect(page.locator('#editor-root .cm-line').first()).toHaveText(title);
  expect(await visibleTitleCount(page, title)).toBe(1);
  // 行が折り返すと End は視覚行の末尾へ移る。tap 直後の caret はタイトル行の先頭なので、
  // 折り返しの有無に依らない位置として、そこへ挿入する。
  await page.keyboard.insertText('edited-');
  await expect(page.locator('#editor-root .cm-line')).toHaveText([`edited-${title}`, 'mobile の本文']);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`edited-${title}`);
  await expectMobileLayout(page, expectedWidth);
});

// viewport 360px の閲覧表示で確実に 2 行以上へ折り返す長さ。
const LONG_BODY_LINE = '長い行が編集中も折り返すことを確かめるための本文です。'.repeat(3);

test('mobile browser は編集を開始しても長い行を折り返したまま表示する', async ({ page }, testInfo) => {
  const expectedWidth = expectedViewportWidths[testInfo.project.name];
  if (expectedWidth === undefined) throw new Error(`unexpected mobile project: ${testInfo.project.name}`);
  await loginE2eAccount(page, 'wrap-e2e');

  const title = `mobile-wrap-${testInfo.project.name}-${testInfo.repeatEachIndex}`;
  await createE2ePage(page, title, [LONG_BODY_LINE, 'short body']);

  await page.goto(`/e2e/${title}`);
  await expectMobileLayout(page, expectedWidth);

  await page.locator('#editor-root .line-row').nth(2).tap();
  await expect(page.locator('#editor-root .cm-content')).toBeFocused();
  await expectMobileLayout(page, expectedWidth);

  // 横方向のはみ出しは .cm-scroller の中に隠れるので、document の幅だけでは検出できない。
  const scroller = await page.locator('#editor-root .cm-scroller').evaluate((element) => ({
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
  }));
  expect(scroller.scrollWidth).toBeLessThanOrEqual(scroller.clientWidth);

  const editorHeights = await page.locator('#editor-root .cm-line').evaluateAll((lines) =>
    lines.map((line) => line.getBoundingClientRect().height)
  );
  expect(editorHeights[1]!).toBeGreaterThan(editorHeights[2]! * 1.5);
});

const PARITY_LONG_LINE = '編集開始の前後で字と位置が変わらないことを確かめる本文です。'.repeat(2);
// 引用行は要素そのものが違う（blockquote と q）。対象外で、#188 の残りとして #201 で扱う。
const PARITY_BODY = [
  PARITY_LONG_LINE,
  '  indented body',
  '[* bold] and #hashtag',
  'spaced    gap   here',
  'table:sample',
  ' left\tright',
  'short body',
];

test('mobile browser でも編集開始の前後で本文の字と位置が変わらない', async ({ page }, testInfo) => {
  const expectedWidth = expectedViewportWidths[testInfo.project.name];
  if (expectedWidth === undefined) throw new Error(`unexpected mobile project: ${testInfo.project.name}`);
  await loginE2eAccount(page, 'parity-e2e');

  const title = `mobile-parity-${testInfo.project.name}-${testInfo.repeatEachIndex}`;
  await createE2ePage(page, title, PARITY_BODY);

  await page.goto(`/e2e/${title}`);
  const beforeTitleStyle = await textStyleOf(page, title);
  const beforeBodyStyle = await textStyleOf(page, PARITY_LONG_LINE);
  const beforeBoxes = await lineTextBoxes(page);
  // 文字を持たない行があると lineTextBoxes が 0 を返し、一致の assertion が素通りする。
  for (const box of beforeBoxes) expect(box.width).toBeGreaterThan(0);

  await page.locator('#editor-root .line-row').nth(PARITY_BODY.length).tap();
  await expect(page.locator('#editor-root .cm-content')).toBeFocused();
  await expectMobileLayout(page, expectedWidth);

  expect(await textStyleOf(page, title)).toEqual(beforeTitleStyle);
  expect(await textStyleOf(page, PARITY_LONG_LINE)).toEqual(beforeBodyStyle);
  const afterBoxes = await lineTextBoxes(page);
  expect(afterBoxes).toHaveLength(beforeBoxes.length);
  for (const [index, before] of beforeBoxes.entries()) expectSameTextBox(index, before, afterBoxes[index]!);
});

// 引用行は閲覧表示が blockquote、編集表示が q で、要素そのものが違っていた（#201）。
// mobile でも一致することを直接見る。#188 の受け入れ条件は mobile を含む。
const QUOTE_BODY = ['> quoted line', '> [linked] in quote', 'plain body'];

test('mobile browser でも引用行が編集開始の前後で同じ位置・同じ字で描かれる', async ({ page }, testInfo) => {
  const expectedWidth = expectedViewportWidths[testInfo.project.name];
  if (expectedWidth === undefined) throw new Error(`unexpected mobile project: ${testInfo.project.name}`);
  await loginE2eAccount(page, 'quote-e2e');

  const title = `mobile-quote-${testInfo.project.name}-${testInfo.repeatEachIndex}`;
  await createE2ePage(page, title, QUOTE_BODY);

  const quoteColor = async (): Promise<string> => page.evaluate(() => {
    const root = document.querySelector('#editor-root');
    if (root === null) throw new Error('editor root is missing');
    const element = Array.from(root.querySelectorAll<HTMLElement>('*')).find((candidate) =>
      candidate.children.length === 0 && candidate.textContent === ' quoted line'
    );
    if (element === undefined) throw new Error('the quoted line is not rendered');
    return getComputedStyle(element).color;
  });

  await page.goto(`/e2e/${title}`);
  await expectMobileLayout(page, expectedWidth);
  const beforeStyle = await textStyleOf(page, ' quoted line');
  const beforeColor = await quoteColor();
  const beforeBoxes = await lineTextBoxes(page);
  for (const box of beforeBoxes) expect(box.width).toBeGreaterThan(0);
  // 閲覧表示の blockquote は左に字下げがある。
  expect(beforeBoxes[1]!.x).toBeGreaterThan(beforeBoxes[3]!.x);
  await expect(page.locator('#editor-root .line-row').nth(2).locator('a')).toHaveCount(1);

  await page.locator('#editor-root .line-row').nth(QUOTE_BODY.length).tap();
  await expect(page.locator('#editor-root .cm-content')).toBeFocused();
  await expectMobileLayout(page, expectedWidth);

  expect(await textStyleOf(page, ' quoted line')).toEqual(beforeStyle);
  expect(await quoteColor()).toBe(beforeColor);
  const afterBoxes = await lineTextBoxes(page);
  expect(afterBoxes).toHaveLength(beforeBoxes.length);
  for (const [index, before] of beforeBoxes.entries()) expectSameTextBox(index, before, afterBoxes[index]!);
});

test('mobile browser は長いページの途中から編集を始めても scroll 位置を保つ', async ({ page }, testInfo) => {
  const expectedWidth = expectedViewportWidths[testInfo.project.name];
  if (expectedWidth === undefined) throw new Error(`unexpected mobile project: ${testInfo.project.name}`);
  await loginE2eAccount(page, 'scroll-mobile-e2e');

  const title = `mobile-scroll-${testInfo.project.name}-${testInfo.repeatEachIndex}`;
  await createE2ePage(page, title, Array.from({ length: 100 }, (_, index) => `body line ${index}`));

  await page.goto(`/e2e/${title}`);
  await scrollRowTo(page, 70, 300);
  const tappedRowTop = async (): Promise<{ top: number; viewportHeight: number }> => page.evaluate(() => {
    const rows = document.querySelectorAll('#editor-root .line-row, #editor-root .cm-line');
    const row = Array.from(rows).find((candidate) => candidate.textContent?.trim() === 'body line 69');
    if (row === undefined) throw new Error('the tapped line is not rendered');
    return { top: Math.round(row.getBoundingClientRect().top), viewportHeight: window.innerHeight };
  });
  const before = await tappedRowTop();
  expect(before.top).toBeGreaterThanOrEqual(0);
  expect(before.top).toBeLessThan(before.viewportHeight);

  await page.locator('#editor-root .line-row').nth(70).tap();
  await expect(page.locator('#editor-root .cm-content')).toBeFocused();
  await expectMobileLayout(page, expectedWidth);

  const after = await tappedRowTop();
  expect(after.top).toBeGreaterThanOrEqual(0);
  expect(after.top).toBeLessThan(after.viewportHeight);
  expect(Math.abs(after.top - before.top)).toBeLessThan(22);
});

test('mobile browser は link だけの行を、遷移と編集のどちらにも tap で到達できる', async ({ page }, testInfo) => {
  const expectedWidth = expectedViewportWidths[testInfo.project.name];
  if (expectedWidth === undefined) throw new Error(`unexpected mobile project: ${testInfo.project.name}`);
  await loginE2eAccount(page, 'link-mobile-e2e');

  const suffix = `${testInfo.project.name}-${testInfo.repeatEachIndex}`;
  // 折り返し位置は font と幅で決まるので、行末ぴったりで終わるラベルの長さを実測する。
  await createE2ePage(page, `mobile-link-probe-${suffix}`, [`[${'あ'.repeat(400)}]`]);
  await page.goto(`/e2e/mobile-link-probe-${suffix}`);
  const capacity = await firstVisualLineLength(page, 1);
  expect(capacity).toBeGreaterThan(4);
  const labels = [capacity, capacity + 1, capacity + 2, capacity * 2].map((length) => 'あ'.repeat(length));

  const target = `mobile-link-target-${suffix}`;
  const title = `mobile-link-only-${suffix}`;
  await createE2ePage(page, target, ['target body']);
  await createE2ePage(page, title, [`[${target}]`, ...labels.map((label) => `[${label}]`)]);

  await page.goto(`/e2e/${title}`);
  await expectMobileLayout(page, expectedWidth);

  // どの長さのラベルでも、行末に余白ぶんのリンクでない面が残る。
  const targets = await linkRowTargets(page);
  expect(targets).toHaveLength(labels.length + 1);
  for (const entry of targets) {
    expect({ length: entry.label.length, wideEnough: entry.trailingGap >= 40, hit: entry.trailingHit })
      .toEqual({ length: entry.label.length, wideEnough: true, hit: 'row' });
  }

  // 面が残っていることと、tap が届くことは別。ブラウザの touch adjustment は tap を
  // 近くのリンクへ吸い寄せるので、リンク寄りの数十 px は hit testing 上リンクの外でも
  // tap すると遷移する。契約は「行末から 24px の帯は実 tap で届く」なので、その帯の
  // 内側の端と外側の端の両方を実際に押す。
  const worst = targets.reduce((min, entry) => (entry.trailingGap < min.trailingGap ? entry : min));
  const rawLine = page.locator('#editor-root .cm-line', { hasText: `[${worst.label}]` });
  for (const inset of [4, 24]) {
    await page.goto(`/e2e/${title}`);
    const row = await linkRowTargets(page);
    const entry = row.find((candidate) => candidate.label === worst.label)!;
    await page.touchscreen.tap(entry.rowRight - inset, entry.y);
    await expect(page.locator('#editor-root .cm-content')).toBeFocused();
    await expect(page).toHaveURL(`/e2e/${title}`);
    await expect(rawLine).toHaveCount(1);
    await expect(rawLine.locator('a')).toHaveCount(0);
  }
  await expectMobileLayout(page, expectedWidth);

  // リンク自体の tap は遷移のまま。ラベルが折り返しても当たるよう、1 つ目の矩形を押す。
  await page.reload();
  const linkPoint = await firstRectCenter(page, '#editor-root .line-row:nth-of-type(2) a');
  await page.touchscreen.tap(linkPoint.x, linkPoint.y);
  await expect(page).toHaveURL(new RegExp(`/e2e/${target}$`));
});

// 1 行に収まる長さにする。折り返すと行の高さが変わり、比べたい値ではなくなる。
const GEOMETRY_BODY = ['紙面の位置を合わせる本文', '', 'last body'];

// WebKit は font-family の引用符を省き、font-size を 25.950001px のように直列化する。
// 比べたいのは指定された値なので、表記の違いを揃える。
function normalizedTextStyle(style: Record<string, string>): Record<string, string> {
  const fontSize = Number.parseFloat(style.fontSize ?? '');
  return {
    ...style,
    fontFamily: (style.fontFamily ?? '').replaceAll('"', ''),
    fontSize: `${Math.round(fontSize * 100) / 100}px`,
  };
}

test('mobile browser でも紙面と本文を Cosense と同じ位置と字で描き、編集を始めても動かさない', async (
  { page },
  testInfo,
) => {
  const expectedWidth = expectedViewportWidths[testInfo.project.name];
  if (expectedWidth === undefined) throw new Error(`unexpected mobile project: ${testInfo.project.name}`);
  await loginE2eAccount(page, 'geometry-mobile-e2e');

  // タイトルも 1 行に収める。
  const title = `mg-${testInfo.project.name.replace('mobile-', '')}-${testInfo.repeatEachIndex}`;
  await createE2ePage(page, title, GEOMETRY_BODY);

  await page.goto(`/e2e/${title}`);
  await expectMobileLayout(page, expectedWidth);
  // Cosense の 767px 以下の値。紙面は左右 8px を残して広がり、本文は紙面の左 21px から始まる。
  const expected = {
    bodyBackground: 'rgb(220, 221, 224)',
    bar: { height: 41, background: 'rgba(196, 197, 202, 0.7)' },
    paper: { x: 8, y: 72, width: expectedWidth - 16, background: 'rgb(254, 254, 254)', padding: [28, 21, 42, 21] },
    telomereLeft: 8,
  };
  expect(await pageGeometry(page)).toEqual(expected);
  const textLefts = (await lineTextBoxes(page)).map((box) => box.x);
  expect(textLefts).toEqual([29, 29, 0, 29]);
  const font = 'Roboto, Helvetica, Arial, Hiragino Sans, sans-serif';
  const titleStyle = { fontFamily: font, fontSize: '25.95px', fontWeight: '400', lineHeight: '42px', color: 'rgb(0, 0, 0)' };
  const bodyStyle = { fontFamily: font, fontSize: '15px', fontWeight: '400', lineHeight: '28px', color: 'rgb(74, 74, 74)' };
  expect(normalizedTextStyle(await textStyleOf(page, title))).toEqual(titleStyle);
  expect(normalizedTextStyle(await textStyleOf(page, GEOMETRY_BODY[0]!))).toEqual(bodyStyle);
  expect(await rowHeights(page)).toEqual([63, 28, 28, 28]);

  // Cosense は 767px 以下でページメニューを上部のバーへ移す。ページ操作がバーの中にあり、画面内で押せる。
  const menu = (await page.locator('#page-actions > summary').boundingBox())!;
  expect(menu.y).toBeGreaterThanOrEqual(0);
  expect(menu.y + menu.height).toBeLessThanOrEqual(41);
  expect(menu.x + menu.width).toBeLessThanOrEqual(expectedWidth);

  await page.locator('#editor-root .line-row').nth(GEOMETRY_BODY.length).tap();
  await expect(page.locator('#editor-root .cm-content')).toBeFocused();
  await expectMobileLayout(page, expectedWidth);
  expect(await pageGeometry(page)).toEqual(expected);
  expect((await lineTextBoxes(page)).map((box) => box.x)).toEqual(textLefts);
  expect(normalizedTextStyle(await textStyleOf(page, title))).toEqual(titleStyle);
  expect(normalizedTextStyle(await textStyleOf(page, GEOMETRY_BODY[0]!))).toEqual(bodyStyle);
  expect(await rowHeights(page)).toEqual([63, 28, 28, 28]);
});

test('mobile browser でも scroll できるページの上の方から編集を始めて、画面が動かない', async ({ page }, testInfo) => {
  const expectedWidth = expectedViewportWidths[testInfo.project.name];
  if (expectedWidth === undefined) throw new Error(`unexpected mobile project: ${testInfo.project.name}`);
  await loginE2eAccount(page, 'geometry-mobile-e2e');

  const title = `mgs-${testInfo.project.name.replace('mobile-', '')}-${testInfo.repeatEachIndex}`;
  await createE2ePage(page, title, Array.from({ length: 40 }, (_, index) => `line ${index}`));

  await page.goto(`/e2e/${title}`);
  const rowTop = async (): Promise<number> => page.evaluate(() => {
    const rows = document.querySelectorAll('#editor-root .line-row, #editor-root .cm-line');
    const row = Array.from(rows).find((candidate) => candidate.textContent?.trim() === 'line 2');
    if (row === undefined) throw new Error('the tapped line is not rendered');
    return row.getBoundingClientRect().top;
  });
  const before = await rowTop();

  await page.locator('#editor-root .line-row').nth(3).tap();
  await expect(page.locator('#editor-root .cm-content')).toBeFocused();
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect(await rowTop()).toBe(before);
});

// 360px でも確実に折り返す長さ。字下げの段は Cosense と同じ 22.5px（#231）。
const MOBILE_INDENT_BODY = [
  ` ${'字下げした長い行が mobile でも同じ位置で折り返すことを確かめる。'.repeat(2)}`,
  `  ${'二段目の長い行も同じ位置で折り返す。'.repeat(3)}`,
  ' > 字下げした引用',
  'last body',
];

test('mobile browser でも字下げの段・行頭の印・折り返しを閲覧表示と編集表示で揃える', async ({ page }, testInfo) => {
  const expectedWidth = expectedViewportWidths[testInfo.project.name];
  if (expectedWidth === undefined) throw new Error(`unexpected mobile project: ${testInfo.project.name}`);
  await loginE2eAccount(page, 'line-mobile-e2e');

  const title = `mi-${testInfo.project.name.replace('mobile-', '')}-${testInfo.repeatEachIndex}`;
  await createE2ePage(page, title, MOBILE_INDENT_BODY);

  await page.goto(`/e2e/${title}`);
  await expectMobileLayout(page, expectedWidth);
  const dot = { x: -15, y: 10, width: 6, height: 6, color: 'rgb(85, 85, 85)', radius: '50%' };
  const dash = { x: -15, y: 12.5, width: 6, height: 2, color: 'rgb(85, 85, 85)', radius: '0px' };
  const marks = [
    null,
    { textLeft: 29 + 22.5, mark: dot },
    { textLeft: 29 + 45, mark: dot },
    { textLeft: 29 + 22.5, mark: dash },
    null,
  ];
  expect(await indentMarks(page)).toEqual(marks);
  const lines = await visualLineRects(page);
  // 折り返した 2 本目以降は本文の開始位置から始まる。
  expect(lines[1]!.slice(1).map(([left]) => left)).toEqual(lines[1]!.slice(1).map(() => Math.round(29 + 22.5)));
  expect(lines[2]!.slice(1).map(([left]) => left)).toEqual(lines[2]!.slice(1).map(() => 29 + 45));
  expect(lines[1]!.length).toBeGreaterThan(2);
  expect(lines[2]!.length).toBeGreaterThan(2);

  await page.locator('#editor-root .line-row').nth(MOBILE_INDENT_BODY.length).tap();
  await expect(page.locator('#editor-root .cm-content')).toBeFocused();
  await expectMobileLayout(page, expectedWidth);
  expect(await indentMarks(page)).toEqual(marks);
  expect(await visualLineRects(page)).toEqual(lines);
});
