import { test, expect, type Page } from '@playwright/test';
import {
  createE2ePage,
  indentMarks,
  lineRowClickPosition,
  loginE2eAccount,
  visualLineRects,
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
  // 本文の画像は高さ 300px まで、[[画像]] は高さの上限が無く幅は本文の 95% まで。
  // 本文の幅は 862px から行末の余白 2.5rem を除いた 822px。アイコンは 1.3em、大きいアイコンは 3.9em。
  const expected = [[450, 300], [66.7, 300], [780.9, 195.2], [19.5, 19.5], [58.5, 58.5]];
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
