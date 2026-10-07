import { test, expect, type Page } from '@playwright/test';
import {
  blockLooks,
  createE2ePage,
  indentMarks,
  lineRowClickPosition,
  loginE2eAccount,
  visualLineRects,
  type BlockLook,
  type IndentMark,
} from './helpers.ts';

// 1280px の本文の左端（#229）と、Cosense の既定テーマで測った字下げと行頭の印（#231）。
const TEXT_LEFT = 181;
const INDENT = 22.5;
const DOT = { x: -15, y: 10, width: 6, height: 6, color: 'rgb(85, 85, 85)', radius: '50%' };
const DASH = { x: -15, y: 12.5, width: 6, height: 2, color: 'rgb(85, 85, 85)', radius: '0px' };

async function startEditingAtLastRow(page: Page, bodyLength: number): Promise<void> {
  await page.locator('#editor-root .line-row').nth(bodyLength).click({ position: lineRowClickPosition });
  await expect(page.locator('#editor-root .cm-content')).toBeFocused();
}

const MARK_BODY = [
  ' 一段目の行',
  '  二段目の行',
  ' > 字下げした引用',
  ' 1. 番号付きの行',
  ' code:sample.js',
  '  const a = 1;',
  ' table:sample',
  '  a\tb',
  'last body',
];

function level(depth: number, mark: IndentMark['mark']): IndentMark {
  return { textLeft: TEXT_LEFT + INDENT * depth, mark };
}

// 引用行と番号付きの行は横線、コードブロックの本文行と表の行には印が無い。見出しの行には点が付く。
const EXPECTED_MARKS: (IndentMark | null)[] = [
  null,
  level(1, DOT),
  level(2, DOT),
  level(1, DASH),
  level(1, DASH),
  level(1, DOT),
  level(1, null),
  level(1, DOT),
  level(1, null),
  null,
];

test('字下げは 1 段 22.5px で、行頭に Cosense と同じ点か横線を置き、編集を始めても変えない', async (
  { page },
  testInfo,
) => {
  await loginE2eAccount(page, 'line-e2e');
  const title = `line-marks-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  await createE2ePage(page, title, MARK_BODY);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/e2e/${title}`);
  expect(await indentMarks(page)).toEqual(EXPECTED_MARKS);

  await startEditingAtLastRow(page, MARK_BODY.length);
  expect(await indentMarks(page)).toEqual(EXPECTED_MARKS);
});

// 1280px で 2 行以上に折り返す長さ。
const WRAP_BODY = [
  ` ${'字下げした長い行が折り返したときの二行目の位置を確かめる。'.repeat(4)}`,
  `  ${'二段目の長い行も同じように折り返したときの位置を確かめる本文です。'.repeat(3)}`,
  'last body',
];

test('折り返した字下げ行は 2 行目以降も字下げの位置から始まり、編集を始めても変わらない', async (
  { page },
  testInfo,
) => {
  await loginE2eAccount(page, 'line-e2e');
  const title = `line-wrap-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  await createE2ePage(page, title, WRAP_BODY);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/e2e/${title}`);
  const before = await visualLineRects(page);
  for (const [row, depth] of [[1, 1], [2, 2]] as const) {
    const lines = before[row]!;
    expect(lines.length).toBeGreaterThanOrEqual(2);
    // 1 本目は字下げの空白から、2 本目以降は本文の開始位置から始まる。
    expect(lines.map(([left]) => left)).toEqual([
      TEXT_LEFT,
      ...lines.slice(1).map(() => Math.round(TEXT_LEFT + INDENT * depth)),
    ]);
  }

  await startEditingAtLastRow(page, WRAP_BODY.length);
  expect(await visualLineRects(page)).toEqual(before);
});

type LinkLook = { text: string; color: string; decoration: string };

async function linkLooks(page: Page, rowIndex: number): Promise<LinkLook[]> {
  return page.locator('#editor-root .line-row, #editor-root .cm-line').nth(rowIndex).locator('a').evaluateAll(
    (anchors) => anchors.map((anchor) => {
      const style = getComputedStyle(anchor);
      return { text: anchor.textContent ?? '', color: style.color, decoration: style.textDecorationLine };
    }),
  );
}

test('リンクを Cosense と同じ色と下線で描き、hover とカーソル行でも Cosense と同じ色にする', async (
  { page },
  testInfo,
) => {
  await loginE2eAccount(page, 'line-e2e');
  const suffix = `${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  const target = `line-link-target-${suffix}`;
  const missing = `line-link-missing-${suffix}`;
  const title = `line-links-${suffix}`;
  await createE2ePage(page, target, ['target body']);
  const body = [`[${target}] [${missing}] #${target} [https://example.com 外部] https://example.com/bare`, 'last body'];
  await createE2ePage(page, title, body);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/e2e/${title}`);
  const pageLink = 'rgb(61, 114, 245)';
  const expected: LinkLook[] = [
    { text: target, color: pageLink, decoration: 'none' },
    { text: missing, color: 'rgb(253, 115, 115)', decoration: 'none' },
    { text: `#${target}`, color: pageLink, decoration: 'none' },
    { text: '外部', color: pageLink, decoration: 'underline' },
    { text: 'https://example.com/bare', color: pageLink, decoration: 'underline' },
  ];
  expect(await linkLooks(page, 1)).toEqual(expected);

  await startEditingAtLastRow(page, body.length);
  expect(await linkLooks(page, 1)).toEqual(expected);

  // hover できる環境では、内部リンクと空リンクの色が濃くなる。
  const row = page.locator('#editor-root .cm-line').nth(1);
  await row.locator('a').nth(0).hover();
  await expect(row.locator('a').nth(0)).toHaveCSS('color', 'rgb(13, 79, 243)');
  await row.locator('a').nth(1).hover();
  await expect(row.locator('a').nth(1)).toHaveCSS('color', 'rgb(252, 65, 65)');

  // カーソル行の原文表示でも、リンクは同じ色のまま記法だけが見える。
  const rowBox = (await row.boundingBox())!;
  await page.mouse.click(rowBox.x + rowBox.width - 8, rowBox.y + 8);
  await expect(row.locator('a')).toHaveCount(0);
  const rawColors = await row.locator('.cm-sb-link, .cm-sb-hashtag, .cm-sb-external-link, .cm-sb-url').evaluateAll(
    (spans) => spans.map((span) => getComputedStyle(span).color),
  );
  expect(rawColors.length).toBeGreaterThanOrEqual(5);
  for (const color of rawColors) expect(color).toBe(pageLink);
});

test('字下げした行でも、リンクの click は遷移し、行末の click は原文の編集に入る', async ({ page }, testInfo) => {
  await loginE2eAccount(page, 'line-e2e');
  const suffix = `${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  const target = `line-indent-link-target-${suffix}`;
  const title = `line-indent-link-${suffix}`;
  await createE2ePage(page, target, ['target body']);
  const body = [` [${target}]`, 'last body'];
  await createE2ePage(page, title, body);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/e2e/${title}`);
  // タイトル行から始めて、字下げしたリンクの行を整形表示のまま残す。
  await page.locator('#editor-root .line-row').first().click({ position: lineRowClickPosition });
  await expect(page.locator('#editor-root .cm-content')).toBeFocused();
  const row = page.locator('#editor-root .cm-line').nth(1);
  await row.locator('a').click();
  await expect(page).toHaveURL(new RegExp(`/e2e/${target}$`));

  await page.goBack();
  await page.locator('#editor-root .line-row').first().click({ position: lineRowClickPosition });
  await expect(page.locator('#editor-root .cm-content')).toBeFocused();
  const box = (await row.boundingBox())!;
  await page.mouse.click(box.x + box.width - 8, box.y + 8);
  await expect(page).toHaveURL(`/e2e/${title}`);
  await expect(row).toHaveText(` [${target}]`);
  await expect(row.locator('a')).toHaveCount(0);
  // 行末をクリックしたので caret は行末にある。そのまま入力すると行末に入る。
  await page.keyboard.insertText('!');
  await expect(row).toHaveText(` [${target}]!`);
});

type CodeLook = { fontFamily: string; fontSize: string; color: string; background: string; radius: string; quote: string };

// 行の中の code 要素の見た目。両端のバッククオートは ::before / ::after で描く。
async function codeLooks(page: Page, rowIndex: number): Promise<CodeLook[]> {
  return page.locator('#editor-root .line-row, #editor-root .cm-line').nth(rowIndex).locator('code').evaluateAll(
    (codes) => codes.map((code) => {
      const style = getComputedStyle(code);
      const before = getComputedStyle(code, '::before');
      return {
        fontFamily: style.fontFamily.replaceAll('"', ''),
        fontSize: style.fontSize,
        color: style.color,
        background: style.backgroundColor,
        radius: style.borderRadius,
        quote: before.content === 'none' ? 'none' : `${before.content} ${before.opacity}`,
      };
    }),
  );
}

test('インラインコード・コマンドライン・数式を Cosense と同じコードの見た目にし、編集を始めても変えない', async (
  { page },
  testInfo,
) => {
  await loginE2eAccount(page, 'line-e2e');
  const title = `line-code-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  const body = ['`inline code` の行', '$ ls -la', '[$ x^2] の数式', 'last body'];
  await createE2ePage(page, title, body);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/e2e/${title}`);
  const code = {
    fontFamily: 'Menlo, Monaco, Consolas, Courier New, monospace',
    fontSize: '13.5px',
    color: 'rgb(52, 45, 156)',
    background: 'rgba(0, 0, 0, 0.04)',
    radius: '4px',
  };
  // バッククオートで囲んだコードだけ、両端のバッククオートが薄く残る。
  const expected = [[{ ...code, quote: '"`" 0.1' }], [{ ...code, quote: 'none' }], [{ ...code, quote: 'none' }]];
  const looks = async (): Promise<CodeLook[][]> => [await codeLooks(page, 1), await codeLooks(page, 2), await codeLooks(page, 3)];
  expect(await looks()).toEqual(expected);
  const before = await visualLineRects(page);

  await startEditingAtLastRow(page, body.length);
  expect(await looks()).toEqual(expected);
  expect(await visualLineRects(page)).toEqual(before);
});

type StrongLook = { text: string; fontSize: string; lineHeight: string; fontWeight: string; fontStyle: string };

function look(text: string, fontSize: string, lineHeight: string, fontStyle = 'normal'): StrongLook {
  return { text, fontSize, lineHeight, fontWeight: '700', fontStyle };
}

test('強調の段階ごとに Cosense と同じ大きさと行送りで描き、重ねた装飾も保つ', async ({ page }, testInfo) => {
  await loginE2eAccount(page, 'line-e2e');
  const title = `line-strong-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  const body = ['[* 一段] [[太字]] [/* 太字斜体]', '[** 二段]', '[*** 三段]', '[**** 四段]', '[***** 五段]', 'last body'];
  await createE2ePage(page, title, body);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/e2e/${title}`);
  const strongs = async (): Promise<StrongLook[]> => page.evaluate(() => {
    const root = document.querySelector('#editor-root');
    if (root === null) throw new Error('editor root is missing');
    return Array.from(root.querySelectorAll('strong'), (strong) => {
      const leaf = strong.querySelector('em') ?? strong;
      const style = getComputedStyle(leaf);
      return {
        text: strong.textContent ?? '',
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
        fontWeight: style.fontWeight,
        fontStyle: style.fontStyle,
      };
    });
  });
  const expected = [
    look('一段', '15px', '28px'),
    look('太字', '15px', '28px'),
    look('太字斜体', '15px', '28px', 'italic'),
    look('二段', '18px', '28px'),
    look('三段', '21.6px', '35px'),
    look('四段', '25.95px', '42px'),
    look('五段', '31.05px', '49px'),
  ];
  expect(await strongs()).toEqual(expected);
  const rowsBefore = await page.evaluate(() => Array.from(
    document.querySelectorAll('#editor-root .line-row'),
    (row) => Math.round(row.getBoundingClientRect().height),
  ));
  // 行送りの大きい強調を含む行は、その行送りまで高くなる。
  expect(rowsBefore.slice(2, 6).map((height, index) => height >= [28, 35, 42, 49][index]!)).toEqual([true, true, true, true]);
  const before = await visualLineRects(page);

  await startEditingAtLastRow(page, body.length);
  expect(await strongs()).toEqual(expected);
  expect(await visualLineRects(page)).toEqual(before);
});

function svg(width: number, height: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#89a"/></svg>`;
}

test('本文の画像とアイコンを Cosense と同じ大きさの規則で描き、編集を始めても変えない', async ({ page }, testInfo) => {
  await loginE2eAccount(page, 'line-e2e');
  const suffix = `${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  const sizes: Record<string, [number, number]> = {
    'wide.png': [600, 400],
    'tall.png': [200, 900],
    'banner.png': [1600, 400],
    'icon.png': [64, 64],
  };
  await page.route('https://i.gyazo.com/**', (route) => {
    const name = new URL(route.request().url()).pathname.slice(1);
    const [width, height] = sizes[name] ?? [10, 10];
    return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: svg(width, height) });
  });
  const iconPage = `line-icon-${suffix}`;
  await createE2ePage(page, iconPage, ['https://i.gyazo.com/icon.png']);
  const title = `line-media-${suffix}`;
  const body = [
    '[https://i.gyazo.com/wide.png]',
    '[https://i.gyazo.com/tall.png]',
    '[[https://i.gyazo.com/banner.png]]',
    `アイコン [${iconPage}.icon] と大きいアイコン [[${iconPage}.icon]]`,
    'last body',
  ];
  await createE2ePage(page, title, body);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/e2e/${title}`);
  const images = async (): Promise<number[][]> => {
    await page.waitForFunction(() => Array.from(
      document.querySelectorAll<HTMLImageElement>('#editor-root img:not(.cm-widgetBuffer)'),
      (image) => image.complete && image.naturalWidth > 0,
    ).every(Boolean));
    return page.locator('#editor-root img:not(.cm-widgetBuffer)').evaluateAll((elements) => elements.map((image) => {
      const box = image.getBoundingClientRect();
      return [Math.round(box.width * 10) / 10, Math.round(box.height * 10) / 10];
    }));
  };
  // 本文の画像は高さ 300px まで、[[画像]] は高さの上限が無く幅は本文（862px）の 95% まで。
  // アイコンは 1.3em、大きいアイコンは 3.9em。
  const expected = [[450, 300], [66.7, 300], [818.9, 204.7], [19.5, 19.5], [58.5, 58.5]];
  expect(await images()).toEqual(expected);
  const iconOffset = await page.locator('#editor-root img.icon-img').first().evaluate((image) => getComputedStyle(image).top);
  expect(iconOffset).toBe('-4.5px');
  const rows = async (): Promise<number[]> => page.evaluate(() => Array.from(
    document.querySelectorAll('#editor-root .line-row, #editor-root .cm-line'),
    (row) => Math.round(row.getBoundingClientRect().height),
  ));
  const rowsBefore = await rows();

  await startEditingAtLastRow(page, body.length);
  expect(await images()).toEqual(expected);
  expect(await rows()).toEqual(rowsBefore);
});

// コードブロック・引用・表の行で、段数 depth の本文の開始位置と、帯と札の見た目（#237）。
function levelLeft(depth: number): number {
  return TEXT_LEFT + INDENT * depth;
}

function codeLabel(depth: number): BlockLook['label'] {
  return { x: levelLeft(depth), background: 'rgb(255, 207, 198)', fontSize: '12.825px', color: 'rgb(52, 45, 156)' };
}

// 帯は本文の右端まで引く。1280px の本文の右端は 1043px（#245）。
const BAND_RIGHT = 1043;

function codeBand(depth: number): BlockLook['band'] {
  return {
    x: levelLeft(depth),
    right: BAND_RIGHT,
    background: 'rgba(0, 0, 0, 0.04)',
    borderLeft: '0px none rgb(52, 45, 156)',
    paddingLeft: '22.5px',
  };
}

function quoteBand(depth: number): BlockLook['band'] {
  return {
    x: levelLeft(depth),
    right: BAND_RIGHT,
    background: 'rgba(0, 0, 0, 0.05)',
    borderLeft: '1px solid rgb(160, 160, 160)',
    paddingLeft: '3px',
  };
}

const BLOCK_BODY = [
  'code:top.js',
  ' top()',
  'between',
  ' code:nested.js',
  '  nested()',
  `  ${'long_code_line_'.repeat(80)}`,
  '> quoted',
  ' > indented quote',
  ' table:sample',
  '  a\tbb',
  '  ccc\td',
  'last body',
];

test('引用・コードブロック・表を Cosense と同じ帯・札・セルで描き、編集を始めても変えない', async ({ page }, testInfo) => {
  await loginE2eAccount(page, 'line-e2e');
  const title = `line-blocks-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  await createE2ePage(page, title, BLOCK_BODY);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/e2e/${title}`);
  const looks = await blockLooks(page);
  // コードブロックの行は 25.5px。見出しは名前だけの札、本文は見出しの段から帯を引き、字は 1 段深い。
  expect(looks[1]).toMatchObject({ height: 25.5, label: codeLabel(0), band: null });
  expect(looks[2]).toMatchObject({ height: 25.5, band: codeBand(0), textX: levelLeft(1) });
  expect(looks[4]).toMatchObject({ height: 25.5, label: codeLabel(1) });
  expect(looks[5]).toMatchObject({ height: 25.5, band: codeBand(1), textX: levelLeft(2) });
  // 長いコードの行は折り返す。
  expect(looks[6]!.height).toBeGreaterThan(25.5 * 2);
  // 引用は本文の位置から帯を引き、行の高さは本文と同じ。
  expect(looks[7]).toMatchObject({ height: 28, band: quoteBand(0) });
  expect(looks[8]).toMatchObject({ height: 28, band: quoteBand(1) });
  expect(looks[7]!.textX!).toBeGreaterThan(levelLeft(0) + 4);
  // 表の見出しは名前だけの札、行のセルは見出しと同じ段から交互の背景で並ぶ。
  expect(looks[9]).toMatchObject({
    height: 28,
    label: { x: levelLeft(1), background: 'rgb(255, 207, 198)', fontSize: '13.5px', color: 'rgb(74, 74, 74)' },
  });
  for (const row of [looks[10]!, looks[11]!]) {
    expect(row.height).toBe(28);
    expect(row.cells.map(({ background, padding }) => ({ background, padding }))).toEqual([
      { background: 'rgba(0, 0, 0, 0.04)', padding: '0px 2px 0px 8px' },
      { background: 'rgba(0, 0, 0, 0.06)', padding: '0px 2px 0px 8px' },
    ]);
    expect(row.cells[0]!.x).toBe(levelLeft(1));
  }
  const documentWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(documentWidth).toBeLessThanOrEqual(1280);
  const rects = await visualLineRects(page);

  await startEditingAtLastRow(page, BLOCK_BODY.length);
  expect(await blockLooks(page)).toEqual(looks);
  expect(await visualLineRects(page)).toEqual(rects);
});

test('表の見出しの click で原文の編集に入り、コードブロックの行末の click で行末に caret が入る', async (
  { page },
  testInfo,
) => {
  await loginE2eAccount(page, 'line-e2e');
  const title = `line-blocks-click-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  await createE2ePage(page, title, BLOCK_BODY);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/e2e/${title}`);
  await page.locator('#editor-root .line-row').first().click({ position: lineRowClickPosition });
  await expect(page.locator('#editor-root .cm-content')).toBeFocused();

  await page.locator('#editor-root .cm-line').nth(9).locator('.table-block-start').click();
  await expect(page.locator('#editor-root .cm-line').nth(9)).toHaveText(' table:sample');

  // コードの行の行末の余白を押すと、その行の行末に caret が入る（#186 と同じ）。
  const codeRow = page.locator('#editor-root .cm-line').nth(2);
  const box = (await codeRow.boundingBox())!;
  await page.mouse.click(box.x + box.width - 8, box.y + 8);
  await expect(codeRow).toHaveText(' top()');
  await page.keyboard.insertText('!');
  await expect(codeRow).toHaveText(' top()!');
});

// カーソルのある字下げした行（#241）。
const ACTIVE_INDENT_BODY = [
  ' 一段目の行',
  `  ${'二段目の長い行は、カーソルが入っても折り返した二行目が字下げの位置から始まる。'.repeat(2)}`,
  'last body',
];

// カーソル行の、字の開始位置（視覚行ごとの左端）と行頭の印の位置（行の上端からの相対値）。
// 印は字下げの最後の widget の ::after に描く。
async function activeLineLook(page: Page, rowIndex: number): Promise<{ lefts: number[]; mark: { x: number; y: number } | null }> {
  const lines = (await visualLineRects(page))[rowIndex]!;
  const mark = await page.locator('#editor-root .cm-line').nth(rowIndex).evaluate((row) => {
    const widget = Array.from(row.querySelectorAll('.cm-indent-space')).at(-1);
    if (widget === undefined) return null;
    const style = getComputedStyle(widget, '::after');
    if (style.content === 'none') return null;
    const box = widget.getBoundingClientRect();
    return {
      x: Math.round((box.left + Number.parseFloat(style.left)) * 2) / 2,
      y: Math.round((box.top - row.getBoundingClientRect().top + Number.parseFloat(style.top)) * 2) / 2,
    };
  });
  return { lefts: lines.map(([left]) => left!), mark };
}

test('カーソルのある字下げした行でも、字の位置・折り返し・行頭の点を変えない', async ({ page }, testInfo) => {
  await loginE2eAccount(page, 'active-line-e2e');
  const title = `line-active-indent-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  await createE2ePage(page, title, ACTIVE_INDENT_BODY);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/e2e/${title}`);
  // タイトル行から始めて、字下げした行を整形表示のまま測る。
  await page.locator('#editor-root .line-row').first().click({ position: lineRowClickPosition });
  await expect(page.locator('#editor-root .cm-content')).toBeFocused();
  const marks = await indentMarks(page);
  const wrapped = (await visualLineRects(page))[2]!;
  expect(wrapped.length).toBeGreaterThanOrEqual(2);

  for (const rowIndex of [1, 2]) {
    const formatted = marks[rowIndex]!;
    await page.locator('#editor-root .cm-line').nth(rowIndex).click({ position: { x: 60, y: 8 } });
    // 原文表示になっている。
    await expect(page.locator('#editor-root .cm-line').nth(rowIndex).locator('.cm-wysiwyg-line')).toHaveCount(0);
    const active = await activeLineLook(page, rowIndex);
    // 本文の字は整形表示と同じ位置から始まり、行頭の点も同じ位置にある。
    expect(active.lefts[0]).toBe(Math.round(formatted.textLeft));
    expect(active.mark).toEqual({ x: formatted.textLeft + formatted.mark!.x, y: formatted.mark!.y });
  }
  // 折り返した 2 本目以降も、字下げの位置から始まる。
  const activeWrapped = await activeLineLook(page, 2);
  expect(activeWrapped.lefts.slice(1)).toEqual(wrapped.slice(1).map(([left]) => left));
  expect(activeWrapped.lefts.length).toBe(wrapped.length);
});

test('字下げした行の左の余白か本文の 1 字目を押すと caret は本文の先頭に入り、字下げを増減するとカーソル行の位置も追従する', async (
  { page },
  testInfo,
) => {
  await loginE2eAccount(page, 'active-line-e2e');
  const title = `line-active-caret-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  await createE2ePage(page, title, ACTIVE_INDENT_BODY);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/e2e/${title}`);
  // 閲覧表示の字下げした行の左の余白を押して編集を始める。caret は字下げの後ろ（本文の先頭）に入る。
  await page.locator('#editor-root .line-row').nth(1).click({ position: lineRowClickPosition });
  await expect(page.locator('#editor-root .cm-content')).toBeFocused();
  await page.keyboard.insertText('X');
  const row = page.locator('#editor-root .cm-line').nth(1);
  await expect(row).toHaveText(' X一段目の行');

  const textLeft = async (): Promise<number> => (await activeLineLook(page, 1)).lefts[0]!;
  expect(await textLeft()).toBe(Math.round(TEXT_LEFT + INDENT));
  await page.keyboard.press('Tab');
  await expect(row).toHaveText('  X一段目の行');
  expect(await textLeft()).toBe(TEXT_LEFT + INDENT * 2);
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(row).toHaveText('X一段目の行');
  expect(await textLeft()).toBe(TEXT_LEFT);
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await expect(row).toHaveText('  X一段目の行');

  // 整形表示の字下げした行では、本文の 1 字目の左半分を押すと caret は本文の先頭に入る（#243）。
  const nextRow = (await page.locator('#editor-root .cm-line').nth(2).boundingBox())!;
  await page.mouse.click(TEXT_LEFT + INDENT * 2 + 3, nextRow.y + 14);
  await page.keyboard.insertText('Y');
  await expect(page.locator('#editor-root .cm-line').nth(2)).toHaveText(`  Y${ACTIVE_INDENT_BODY[1]!.trimStart()}`);
  await expect(page.locator('#save-status')).toHaveText('保存済み');
});

test('カーソルのある字下げした行でも、IME の変換中の文字列を確定して保存できる', async ({ page }, testInfo) => {
  await loginE2eAccount(page, 'active-line-e2e');
  const title = `line-active-ime-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  await createE2ePage(page, title, ACTIVE_INDENT_BODY);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/e2e/${title}`);
  await page.locator('#editor-root .line-row').nth(1).click({ position: lineRowClickPosition });
  await expect(page.locator('#editor-root .cm-content')).toBeFocused();
  const textLeftBefore = (await visualLineRects(page))[1]![0]![0];

  // OS の IME は再現できないので、Chromium の IME 入力（変換中の文字列と確定）を CDP で送る。
  const cdp = await page.context().newCDPSession(page);
  for (const text of ['に', 'にほ', 'にほん']) {
    await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
  }
  // 変換中も字下げの位置は変わらない。
  expect((await visualLineRects(page))[1]![0]![0]).toBe(textLeftBefore);
  await cdp.send('Input.insertText', { text: '日本' });

  const row = page.locator('#editor-root .cm-line').nth(1);
  await expect(row).toHaveText(' 日本一段目の行');
  await expect(page.locator('#save-status')).toHaveText('保存済み');
  const persisted = await page.request.get(`/api/pages/e2e/${title}`);
  expect((await persisted.json()).lines.map((line: { text: string }) => line.text)[1]).toBe(' 日本一段目の行');
});
