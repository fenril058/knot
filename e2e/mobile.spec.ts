import { test, expect, type Page, type Response } from '@playwright/test';
import {
  blockLooks,
  charPoint,
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

  // 検索欄は上部のバーにあり、767px 以下では検索ボタンで開く（#247）。
  await page.locator('.nav-search-toggle').tap();
  const search = page.getByRole('searchbox');
  await expect(search).toBeFocused();
  await expect(search).toBeInViewport();
  await search.fill(title);
  const searchHit = page.locator(`.nav-search-candidates a[href="/e2e/${title}"]`);
  await expect(searchHit).toHaveText(title);
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

  // タイトルの 1 字目の左端を tap する。caret は押した字の位置に入る（#243）ので、タイトル行の先頭に入る。
  await heading.tap({ position: { x: 2, y: 21 } });
  await expect(page.locator('#editor-root .cm-content')).toBeFocused();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);
  await expect(page.locator('#editor-root .cm-line').first()).toHaveText(title);
  expect(await visibleTitleCount(page, title)).toBe(1);
  // 行が折り返すと End は視覚行の末尾へ移る。折り返しの有無に依らない位置として、先頭へ挿入する。
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
  // 引用の字は、帯の左の線と見えない > のぶん右から始まる。
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

  // Cosense は 767px 以下でページメニューを上部のバーの右端のつまみにたたむ（#299）。つまみは幅 24px・高さ 40px で、
  // 検索ボタンはその 16px 左。つまみを押すと、3 つのボタン（46 × 40px）が並ぶ帯に広がる。
  const boxOf = async (selector: string): Promise<{ x: number; y: number; width: number; height: number }> =>
    (await page.locator(selector).boundingBox())!;
  const toggle = page.locator('.page-menu-toggle');
  expect(await boxOf('.nav-search-toggle')).toEqual({ x: expectedWidth - 72, y: 4, width: 32, height: 32 });
  expect(await boxOf('.page-menu')).toEqual({ x: expectedWidth - 24, y: 0, width: 24, height: 40 });
  await expect(page.locator('.page-actions > summary, .page-menu-link')).toHaveCount(3);
  await expect(page.locator('.page-actions > summary:visible, .page-menu-link:visible')).toHaveCount(0);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.tap();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(await boxOf('.page-menu')).toEqual({ x: expectedWidth - 162, y: 0, width: 162, height: 40 });
  const buttons = await page.locator('.page-actions > summary, .page-menu-link').evaluateAll((elements) =>
    elements.map((element) => { const { x, y, width, height } = element.getBoundingClientRect(); return { x, y, width, height }; }));
  expect(buttons).toEqual([0, 1, 2].map((index) => ({ x: expectedWidth - 162 + 46 * index, y: 0, width: 46, height: 40 })));
  await expect(page.locator('.page-menu-link')).toHaveCSS('color', 'rgb(255, 255, 255)');
  // ボタンの menu は、Cosense と同じく帯の 2px 下に、画面の右端から 10px のところに右を揃えて開く。
  await page.locator('#page-info > summary').tap();
  const infoMenu = await boxOf('#page-info .page-actions-menu');
  expect({ right: infoMenu.x + infoMenu.width, y: infoMenu.y }).toEqual({ right: expectedWidth - 10, y: 42 });
  await page.locator('#page-info > summary').tap();
  await toggle.tap();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.page-actions > summary:visible, .page-menu-link:visible')).toHaveCount(0);

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

test('mobile browser でも一覧の札を Cosense と同じ 2 列・同じ縦横比で並べる', async ({ page }, testInfo) => {
  const expectedWidth = expectedViewportWidths[testInfo.project.name];
  if (expectedWidth === undefined) throw new Error(`unexpected mobile project: ${testInfo.project.name}`);
  await loginE2eAccount(page, 'cards-mobile-e2e');

  const project = `cards-${testInfo.project.name.replace('mobile-', '')}-${testInfo.repeatEachIndex}`;
  const created = await page.request.post(`/api/knot/projects/${project}`, { headers: { 'X-Knot-Client': 'e2e' } });
  expect(created.ok()).toBe(true);
  for (const title of ['first card', 'second card']) {
    const response = await page.request.post(`/api/knot/pages/${project}/${encodeURIComponent(title)}/commits`, {
      headers: { 'X-Knot-Client': 'e2e' },
      data: {
        commitId: `${project}-${title}`,
        baseVersion: 0,
        ops: [{ type: 'insert', id: `${project}-${title}-0`, after: '_head', text: title }],
      },
    });
    expect(response.ok()).toBe(true);
  }

  await page.goto(`/${project}`);
  await expectMobileLayout(page, expectedWidth);
  const boxes = await page.locator('main > .card-grid > li').evaluateAll((items) => items.map((item) => {
    const box = item.getBoundingClientRect();
    return { x: box.left, width: box.width, height: box.height };
  }));
  // 767px 以下でも札の最小幅は 147px で、間隔は 8px。紙面と同じ左右 8px の余白の内側に 2 列並ぶ。
  const columnWidth = (expectedWidth - 16 - 8) / 2;
  expect(boxes).toHaveLength(2);
  for (const [index, box] of boxes.entries()) {
    expect(box.x).toBeCloseTo(8 + index * (columnWidth + 8), 1);
    expect(box.width).toBeCloseTo(columnWidth, 1);
    expect(box.height).toBeCloseTo(columnWidth * 1.1, 1);
  }
});

const MOBILE_BLOCK_BODY = [
  ' code:sample.js',
  `  ${'mobile_code_line_'.repeat(30)}`,
  '> quoted line',
  ' table:sample',
  '  a\tbb',
  'last body',
];

test('mobile browser でも引用・コードブロック・表を閲覧表示と編集表示で同じに描き、はみ出さない', async (
  { page },
  testInfo,
) => {
  const expectedWidth = expectedViewportWidths[testInfo.project.name];
  if (expectedWidth === undefined) throw new Error(`unexpected mobile project: ${testInfo.project.name}`);
  await loginE2eAccount(page, 'line-mobile-e2e');

  const title = `mb-${testInfo.project.name.replace('mobile-', '')}-${testInfo.repeatEachIndex}`;
  await createE2ePage(page, title, MOBILE_BLOCK_BODY);

  await page.goto(`/e2e/${title}`);
  // 長いコードの行も折り返し、紙面を横にはみ出さない。
  await expectMobileLayout(page, expectedWidth);
  const looks = await blockLooks(page);
  expect(looks[1]!.label).not.toBeNull();
  expect(looks[2]!.height).toBeGreaterThan(25.5 * 2);
  expect(looks[3]!.band?.background).toBe('rgba(0, 0, 0, 0.05)');
  expect(looks[5]!.cells).toHaveLength(2);
  const rects = await visualLineRects(page);

  await page.locator('#editor-root .line-row').nth(MOBILE_BLOCK_BODY.length).tap();
  await expect(page.locator('#editor-root .cm-content')).toBeFocused();
  await expectMobileLayout(page, expectedWidth);
  expect(await blockLooks(page)).toEqual(looks);
  expect(await visualLineRects(page)).toEqual(rects);
});

test('mobile browser でも字下げした行を tap すると、字の位置と点を保ったまま本文の先頭から書ける', async (
  { page },
  testInfo,
) => {
  const expectedWidth = expectedViewportWidths[testInfo.project.name];
  if (expectedWidth === undefined) throw new Error(`unexpected mobile project: ${testInfo.project.name}`);
  await loginE2eAccount(page, 'line-mobile-e2e');

  const title = `ma-${testInfo.project.name.replace('mobile-', '')}-${testInfo.repeatEachIndex}`;
  await createE2ePage(page, title, [' 一段目の行', 'last body']);

  await page.goto(`/e2e/${title}`);
  const formatted = (await indentMarks(page))[1]!;
  expect(formatted.textLeft).toBe(29 + 22.5);

  // 本文の 1 字目の左半分を tap する。caret は押した字の位置（#243）、つまり本文の先頭に入る。
  const rowBox = (await page.locator('#editor-root .line-row').nth(1).boundingBox())!;
  await page.touchscreen.tap(formatted.textLeft + 3, rowBox.y + 14);
  await expect(page.locator('#editor-root .cm-content')).toBeFocused();
  await page.keyboard.insertText('X');
  const row = page.locator('#editor-root .cm-line').nth(1);
  await expect(row).toHaveText(' X一段目の行');
  const active = await row.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let textLeft = 0;
    while (walker.nextNode() !== null && textLeft === 0) {
      const node = walker.currentNode;
      // 字下げの空白（#271）は字ではないので、空白の後ろから測る。
      const start = node instanceof Text && node.parentElement?.closest('.cm-indent-text') != null
        ? node.data.search(/\S/)
        : 0;
      if (start === -1) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      range.setStart(node, start);
      const rect = Array.from(range.getClientRects()).find((candidate) => candidate.width > 0);
      if (rect !== undefined) textLeft = rect.left;
    }
    // 行頭の印は、カーソル行の ::before（#271）。
    const mark = getComputedStyle(element, '::before');
    return {
      textLeft: Math.round(textLeft * 2) / 2,
      markLeft: mark.content === 'none' ? null : element.getBoundingClientRect().left + Number.parseFloat(mark.left),
    };
  });
  expect(active).toEqual({ textLeft: formatted.textLeft, markLeft: formatted.textLeft + formatted.mark!.x });
  await expectMobileLayout(page, expectedWidth);
});

test('mobile browser でも、閲覧表示と整形表示の行を tap した字の位置に caret が入る', async ({ page }, testInfo) => {
  const expectedWidth = expectedViewportWidths[testInfo.project.name];
  if (expectedWidth === undefined) throw new Error(`unexpected mobile project: ${testInfo.project.name}`);
  await loginE2eAccount(page, 'caret-mobile-e2e');

  const title = `mc-${testInfo.project.name.replace('mobile-', '')}-${testInfo.repeatEachIndex}`;
  const body = ['テキストを`[`と`]`で囲む', ' [* 強調] の行', 'last body'];
  await createE2ePage(page, title, body);
  await page.goto(`/e2e/${title}`);

  // 閲覧表示の行の「ス」の右半分を tap して編集を始める（#243）。
  const first = await charPoint(page.locator('#editor-root .line-row').nth(1), 'ス', 0, 0.75);
  await page.touchscreen.tap(first.x, first.y);
  await expect(page.locator('#editor-root .cm-content')).toBeFocused();
  await page.keyboard.insertText('|');

  // 編集表示の整形表示の行では、太字の「強」の左半分を tap する。
  const second = await charPoint(page.locator('#editor-root .cm-line').nth(2), '強', 0, 0.25);
  await page.touchscreen.tap(second.x, second.y);
  await page.keyboard.insertText('|');

  await expect(page.locator('#save-status')).toHaveText('保存済み');
  const persisted = await page.request.get(`/api/pages/e2e/${title}`);
  expect((await persisted.json()).lines.map((line: { text: string }) => line.text))
    .toEqual([title, 'テキス|トを`[`と`]`で囲む', ' [* |強調] の行', 'last body']);
  await expectMobileLayout(page, expectedWidth);
});

test('mobile browser でも本文の行は本文の右端まで字を並べて折り返し、インラインコードの行も 28px にする', async (
  { page },
  testInfo,
) => {
  const expectedWidth = expectedViewportWidths[testInfo.project.name];
  if (expectedWidth === undefined) throw new Error(`unexpected mobile project: ${testInfo.project.name}`);
  await loginE2eAccount(page, 'geometry-mobile-e2e');

  const title = `mr-${testInfo.project.name.replace('mobile-', '')}-${testInfo.repeatEachIndex}`;
  await createE2ePage(page, title, ['あ'.repeat(80), '前 `code` 後', `[${'い'.repeat(80)}]`, 'last body']);
  await page.goto(`/e2e/${title}`);

  // 本文の右端は、紙面の右端から右の padding を除いた位置（#245）。
  const { paper } = await pageGeometry(page);
  const textRight = paper.x + paper.width - paper.padding[1]!;
  const firstLineRight = async (rowIndex: number): Promise<number> => {
    const [left, , width] = (await visualLineRects(page))[rowIndex]![0]!;
    return left! + width!;
  };
  const look = async (): Promise<{ wrap: number; link: number; heights: number[] }> => ({
    wrap: await firstLineRight(1),
    link: await firstLineRight(3),
    heights: await rowHeights(page),
  });
  const ssr = await look();
  // 長い行は本文の右端から全角 1 字（15px）以内まで字が並び、リンクだけの行は行末の余白（#186）を残す。
  expect(ssr.wrap).toBeGreaterThan(textRight - 15);
  expect(ssr.wrap).toBeLessThanOrEqual(textRight);
  expect(ssr.link).toBeLessThanOrEqual(textRight - 40);
  expect(ssr.link).toBeGreaterThan(textRight - 40 - 15);
  expect(ssr.heights[2]).toBe(28);

  // 最後の行の字を tap して編集を始め、測った行はすべて整形表示のまま比べる。行頭の字を tap すると、
  // mobile WebKit の touch adjustment がテロメアへ吸い寄せるので、行頭から離れた字を tap する。
  const lastRow = await charPoint(page.locator('#editor-root .line-row').nth(4), 'y', 0, 0.5);
  await page.touchscreen.tap(lastRow.x, lastRow.y);
  await expect(page.locator('#editor-root .cm-content')).toBeFocused();
  expect(await look()).toEqual(ssr);
  await expectMobileLayout(page, expectedWidth);
});

test('mobile browser では検索ボタンでバーの下に検索欄を開き、本文を押し下げずに候補と結果ページへ移れる', async (
  { page },
  testInfo,
) => {
  const expectedWidth = expectedViewportWidths[testInfo.project.name];
  if (expectedWidth === undefined) throw new Error(`unexpected mobile project: ${testInfo.project.name}`);
  await loginE2eAccount(page, 'search-mobile-e2e');

  // 候補は語の字を順に含むタイトルに合うので、ほかのテストのページに無い字（q・z・x）で始める。
  const title = `qzx-${testInfo.project.name.replace('mobile-', '')}-${testInfo.repeatEachIndex}`;
  await createE2ePage(page, title, ['検索ボタンから探すページ']);
  await page.goto(`/e2e/${title}`);
  const input = page.locator('.nav-search-input');
  await expect(input).toBeHidden();
  const paperBefore = (await page.locator('.page').boundingBox())!;

  // Cosense と同じく、バーの下（y=48）に左右 8px を残して検索欄が開き、入力欄に focus が移る（#247）。
  await page.locator('.nav-search-toggle').tap();
  await expect(input).toBeFocused();
  const box = (await input.boundingBox())!;
  expect([box.x, box.y, box.width, box.height].map(Math.round)).toEqual([8, 48, expectedWidth - 16, 32]);
  expect((await page.locator('.page').boundingBox())!.y).toBe(paperBefore.y);

  await input.pressSequentially(title);
  await expect(page.locator('.nav-search-candidates a')).toHaveText([title]);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(`/e2e/search/page?q=${title}`);
  // 結果ページでは検索欄を開いたまま、見出しと結果をその下に並べる。
  const form = (await page.locator('.nav-search').boundingBox())!;
  const heading = (await page.locator('.search-heading').boundingBox())!;
  expect(heading.y).toBeGreaterThanOrEqual(form.y + form.height);
  await expect(page.locator('.search-result a')).toHaveAttribute('href', `/e2e/${title}`);
  await expectMobileLayout(page, expectedWidth);
});

test('mobile browser でも関連ページを、Links の札と共有するリンク先ごとの 2 列の行に並べる', async ({ page }, testInfo) => {
  const expectedWidth = expectedViewportWidths[testInfo.project.name];
  if (expectedWidth === undefined) throw new Error(`unexpected mobile project: ${testInfo.project.name}`);
  await loginE2eAccount(page, 'cards-mobile-e2e');

  const suffix = `${testInfo.project.name.replace('mobile-', '')}-${testInfo.repeatEachIndex}`;
  const hub = `mgroup-hub-${suffix}`;
  const title = `mgroup-page-${suffix}`;
  await createE2ePage(page, hub, ['リンク先のページ']);
  await createE2ePage(page, `mgroup-other-${suffix}`, [`[${hub}] を共有するページ`]);
  await createE2ePage(page, title, [`[${hub}] へのリンク`]);

  await page.goto(`/e2e/${title}`);
  const groups = await page.locator('.related-group').evaluateAll((lists) => lists.map((list) => {
    const items = Array.from(list.children, (item) => item.getBoundingClientRect());
    const box = list.getBoundingClientRect();
    return {
      label: list.querySelector('.relation-label-card')?.textContent?.trim() ?? '',
      columns: items.map((item) => Math.round(item.x * 10) / 10),
      width: Math.round(items[0]!.width * 10) / 10,
      top: box.top,
      bottom: box.bottom,
    };
  }));
  // 紙面の幅に 2 列（間隔 8px）。行の先頭が見出しの札で、行の間は 32px（#249）。
  const width = Math.round(((expectedWidth - 16 - 8) / 2) * 10) / 10;
  expect(groups.map(({ label, columns, width: cardWidth }) => ({ label, columns, width: cardWidth }))).toEqual([
    { label: 'Links', columns: [8, Math.round((8 + width + 8) * 10) / 10], width },
    { label: hub, columns: [8, Math.round((8 + width + 8) * 10) / 10], width },
  ]);
  expect(Math.round(groups[1]!.top - groups[0]!.bottom)).toBe(32);
  await expectMobileLayout(page, expectedWidth);
});

test('mobile browser では関連ページの並び替えを上の行に、絞り込み欄をその下に置き、tap で並び替えられる', async (
  { page },
  testInfo,
) => {
  const expectedWidth = expectedViewportWidths[testInfo.project.name];
  if (expectedWidth === undefined) throw new Error(`unexpected mobile project: ${testInfo.project.name}`);
  await loginE2eAccount(page, 'related-mobile-e2e');

  // ページは e2e/server.ts が e2e-related に用意する（#281）。
  await page.goto('/e2e-related/rel-base');
  const paper = (await page.locator('.page').boundingBox())!;
  const toolbar = (await page.locator('.related-toolbar').boundingBox())!;
  const sort = (await page.locator('.related-sort').boundingBox())!;
  const filter = (await page.locator('.related-filter').boundingBox())!;
  // Cosense と同じく、並び替えは右端の 42px の行、絞り込み欄はその下で紙面の幅いっぱい。
  expect({ x: toolbar.x, width: toolbar.width, height: toolbar.height }).toEqual({ x: paper.x, width: paper.width, height: 74 });
  expect({ right: sort.x + sort.width, y: sort.y, height: sort.height })
    .toEqual({ right: paper.x + paper.width, y: toolbar.y, height: 42 });
  expect(filter).toEqual({ x: paper.x, y: toolbar.y + 42, width: paper.width, height: 32 });
  await expect(page.locator('.related-sort-tab:visible')).toHaveCount(0);
  await expect(page.locator('.related-sort-menu .sort-menu-current')).toHaveText('関連度');

  await page.locator('.related-sort-menu .sort-menu-toggle').tap();
  await expect(page.locator('.related-sort-menu .sort-menu-options button:visible'))
    .toHaveText(['関連度', '更新日時', '作成日時', '最終アクセス', '被リンク数', 'タイトル']);
  await page.locator('.related-sort-menu .sort-menu-options button', { hasText: 'タイトル' }).tap();
  await expect(page.locator('.related-sort-menu')).not.toHaveAttribute('open');
  await expect(page.locator('.related-sort-menu .sort-menu-current')).toHaveText('タイトル');
  await expect(page.locator('.related-group[aria-label="Links"] h3')).toHaveText(['rel-alpha', 'rel-bravo', 'rel-charlie']);
  await expectMobileLayout(page, expectedWidth);
});

test('mobile browser でも、ページの無いタイトルを空のページで描き、タイトルの行の tap で編集を始める', async (
  { page },
  testInfo,
) => {
  const expectedWidth = expectedViewportWidths[testInfo.project.name];
  if (expectedWidth === undefined) throw new Error(`unexpected mobile project: ${testInfo.project.name}`);
  await loginE2eAccount(page, 'related-mobile-e2e');

  // rel-nowhere-two は e2e/server.ts の rel-new だけがリンクしている、ページの無いタイトル（#289）。
  await page.goto('/e2e-related/rel-nowhere-two');
  const paper = (await page.locator('.page').boundingBox())!;
  expect({ x: paper.x, width: paper.width }).toEqual({ x: 8, width: expectedWidth - 16 });
  await expect(page.locator('#editor-root h1.line-title')).toHaveText('rel-nowhere-two');
  await expect(page.locator('.related-group[aria-label="Links"] h3')).toHaveText(['rel-new']);
  await expectMobileLayout(page, expectedWidth);

  // tap で編集を始めても、字を書かなければページは作られない。
  await page.locator('#editor-root .line-row').first().tap({ position: { x: 30, y: 8 } });
  await expect(page.locator('#editor-root .cm-content')).toBeFocused();
  await expect(page.locator('#editor-root .cm-line')).toHaveText(['rel-nowhere-two']);
});

test('mobile browser でもプロジェクトのトップの新規作成とページ数を画面の中で使える', async ({ page }, testInfo) => {
  const expectedWidth = expectedViewportWidths[testInfo.project.name];
  if (expectedWidth === undefined) throw new Error(`unexpected mobile project: ${testInfo.project.name}`);
  await loginE2eAccount(page, 'cards-mobile-e2e');

  await page.goto('/e2e');
  // 並び替えの展開ボタンは札の並びの右端（#291）で、新規作成はその左。ページ数は画面の右下（#253）。
  const toggle = (await page.locator('.page-sort-menu .sort-menu-toggle').boundingBox())!;
  expect(Math.round(toggle.x + toggle.width)).toBe(expectedWidth - 8);
  const button = (await page.locator('#create-page-button').boundingBox())!;
  expect(Math.round(button.x + button.width)).toBe(Math.round(toggle.x));
  const status = (await page.locator('.page-list-status').boundingBox())!;
  const viewport = page.viewportSize()!;
  expect({ right: Math.round(status.x + status.width), bottom: Math.round(status.y + status.height) })
    .toEqual({ right: viewport.width, bottom: viewport.height });
  await expect(page.locator('.page-list-status')).toHaveText(/^\d+ pages$/);

  await page.locator('#create-page-button').tap();
  await expect(page.locator('#create-page-dialog')).toBeVisible();
  await expectMobileLayout(page, expectedWidth);
});

test('mobile browser でもプロジェクトのトップの並び替えを tap で選べる', async ({ page }, testInfo) => {
  const expectedWidth = expectedViewportWidths[testInfo.project.name];
  if (expectedWidth === undefined) throw new Error(`unexpected mobile project: ${testInfo.project.name}`);
  await loginE2eAccount(page, 'cards-mobile-e2e');

  // e2e-related のページは e2e/server.ts が用意する（#291）。
  await page.goto('/e2e-related');
  await page.locator('.page-sort-menu .sort-menu-toggle').tap();
  const menu = (await page.locator('.page-sort-menu .sort-menu-options').boundingBox())!;
  expect(Math.round(menu.x + menu.width)).toBe(expectedWidth - 8);
  await expectMobileLayout(page, expectedWidth);
  await page.locator('.page-sort-menu .sort-menu-options a', { hasText: 'タイトル' }).tap();
  await expect(page).toHaveURL('/e2e-related?sort=title');
  await expect(page.locator('main > .card-grid .card h2').first()).toHaveText('rel-alpha');
  await expect(page.locator('.page-sort-menu .sort-menu-current')).toHaveText('タイトル');
});

test('mobile browser でもテロメアの tap で更新日時と行へのリンクのメニューに届き、編集中も gutter から届く', async (
  { page },
  testInfo,
) => {
  const expectedWidth = expectedViewportWidths[testInfo.project.name];
  if (expectedWidth === undefined) throw new Error(`unexpected mobile project: ${testInfo.project.name}`);
  await loginE2eAccount(page, 'telomere-mobile-e2e');
  const title = `telomere-mobile-${testInfo.project.name}-${testInfo.repeatEachIndex}`;
  await createE2ePage(page, title, ['first body', 'second body', 'third body', 'fourth body']);
  await page.goto(`/e2e/${title}`);

  // touch では本文の先頭を tap したときにテロメアへ吸い寄せられないよう、押せる幅は線の最大の太さの
  // 10px に留め、高さは行と同じにする（#173）。
  const row = page.locator('#editor-root .line-row').nth(1);
  const telomere = row.locator('.telomere');
  const telomereBox = (await telomere.boundingBox())!;
  expect([telomereBox.width, telomereBox.height].map(Math.round))
    .toEqual([10, Math.round((await row.boundingBox())!.height)]);

  // touch には hover が無いので、tap で帯とメニューを一度に出す。編集は始めない。
  const updated = /^\d{4}\/\d{1,2}\/\d{1,2} \d{1,2}:\d{2}:\d{2}に更新$/;
  const menu = page.locator('.telomere-info');
  await telomere.tap();
  await expect(menu.locator('> *')).toHaveText([updated, 'リンクをコピー', 'リーダブルリンクをコピー']);
  await expect(row).toHaveClass(/\bhighlight\b/);
  await expect(page.locator('#editor-root .cm-editor')).toHaveCount(0);
  const menuBox = (await menu.boundingBox())!;
  expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(expectedWidth);

  // メニューの外を tap すると閉じ、その tap で編集が始まる。メニューは下の 2 行の先頭に重なるので、
  // その下の行を tap する。
  const point = await charPoint(page.locator('#editor-root .line-row').nth(4), 'u', 0, 0.5);
  await page.touchscreen.tap(point.x, point.y);
  await expect(menu).toBeHidden();
  await expect(page.locator('#editor-root .cm-content')).toBeFocused();
  await expect(page.locator('#editor-root .cm-line.highlight')).toHaveText('first body');

  // 編集中の gutter のテロメアも tap で届く（#195）。
  await page.locator('#editor-root .cm-telomere-gutter .telomere').nth(2).tap();
  await expect(menu.locator('> *')).toHaveText([updated, 'リンクをコピー', 'リーダブルリンクをコピー']);
  await expect(page.locator('#editor-root .cm-line.highlight')).toHaveText('second body');
  await expectMobileLayout(page, expectedWidth);
});
