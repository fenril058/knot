import { test, expect, type Page } from '@playwright/test';
import { ulid } from '../src/core/id.ts';
import {
  blockLooks,
  charPoint,
  createE2ePage,
  indentMarks,
  lineRowClickPosition,
  loginE2eAccount,
  rowHeights,
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
    // 字下げは字として数えないので、1 本目も 2 本目以降も本文の開始位置から始まる。
    expect(lines.map(([left]) => left)).toEqual(lines.map(() => Math.round(TEXT_LEFT + INDENT * depth)));
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
  const body = [
    `[${target}] [${missing}] #${target} [https://example.com 外部] https://example.com/bare`,
    `アイコン [${target}.icon] の行`,
    'last body',
  ];
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

  // カーソル行の原文表示は、Cosense のカーソル行と同じ色で記法の字を見せる（#273）。ページへのリンクと
  // ハッシュタグは整形表示と同じ色（ページが無ければ空リンクの色）、外部リンクと URL は紫で下線なし。
  const rowBox = (await row.boundingBox())!;
  await page.mouse.click(rowBox.x + rowBox.width - 8, rowBox.y + 8);
  await expect(row.locator('a')).toHaveCount(0);
  const rawLooks = async (rowIndex: number): Promise<Array<[string, string, string]>> => page.locator('#editor-root .cm-line')
    .nth(rowIndex).locator('[class*="cm-sb-"]').evaluateAll((spans) => spans.map((span) => {
      const style = getComputedStyle(span);
      return [span.textContent ?? '', style.color, style.textDecorationLine] as [string, string, string];
    }));
  const rawUrl = 'rgb(120, 30, 122)';
  expect(await rawLooks(1)).toEqual([
    [`[${target}]`, pageLink, 'none'],
    [`[${missing}]`, 'rgb(253, 115, 115)', 'none'],
    [`#${target}`, pageLink, 'none'],
    ['[https://example.com 外部]', rawUrl, 'none'],
    ['https://example.com/bare', rawUrl, 'none'],
  ]);
  // アイコンは本文の色。
  const iconRow = (await page.locator('#editor-root .cm-line').nth(2).boundingBox())!;
  await page.mouse.click(iconRow.x + iconRow.width - 8, iconRow.y + 8);
  expect(await rawLooks(2)).toEqual([[`[${target}.icon]`, 'rgb(74, 74, 74)', 'none']]);
});

test('ページが無くても、ほかのページからリンクされているリンク先は、閲覧表示と編集表示で空リンクの色にしない', async (
  { page },
  testInfo,
) => {
  await loginE2eAccount(page, 'line-e2e');
  const suffix = `${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  const hub = `line-linked-hub-${suffix}`;
  const lonely = `line-lonely-${suffix}`;
  const title = `line-linked-empty-${suffix}`;
  await createE2ePage(page, `line-linked-other-${suffix}`, [`[${hub}] へのリンク`]);
  const body = [`[${hub}] [${lonely}]`, 'last body'];
  await createE2ePage(page, title, body);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/e2e/${title}`);
  // hub はページが無いが、ほかのページからリンクされている（#285）。lonely はこのページからだけ。
  const expected: LinkLook[] = [
    { text: hub, color: 'rgb(61, 114, 245)', decoration: 'none' },
    { text: lonely, color: 'rgb(253, 115, 115)', decoration: 'none' },
  ];
  expect(await linkLooks(page, 1)).toEqual(expected);

  await startEditingAtLastRow(page, body.length);
  expect(await linkLooks(page, 1)).toEqual(expected);
  const row = page.locator('#editor-root .cm-line').nth(1);
  const rowBox = (await row.boundingBox())!;
  await page.mouse.click(rowBox.x + rowBox.width - 8, rowBox.y + 8);
  await expect(row.locator('a')).toHaveCount(0);
  expect(await row.locator('[class*="cm-sb-"]').evaluateAll((spans) => spans.map((span) => [span.textContent, getComputedStyle(span).color])))
    .toEqual([[`[${hub}]`, 'rgb(61, 114, 245)'], [`[${lonely}]`, 'rgb(253, 115, 115)']]);
});

type AnchorLook = { text: string | null; href: string | null; target: string | null; rel: string | null; color: string; decoration: string };

async function anchorLooks(page: Page, rowIndex: number): Promise<AnchorLook[]> {
  return page.locator('#editor-root .line-row, #editor-root .cm-line').nth(rowIndex).locator('a').evaluateAll(
    (anchors) => anchors.map((anchor) => ({
      text: anchor.textContent,
      href: anchor.getAttribute('href'),
      target: anchor.getAttribute('target'),
      rel: anchor.getAttribute('rel'),
      color: getComputedStyle(anchor).color,
      decoration: getComputedStyle(anchor).textDecorationLine,
    })),
  );
}

test('行へのリンクは「リンク先#行 ID の末尾 6 字」で描き、押すとその行へ移って行を示す', async ({ page }, testInfo) => {
  await loginE2eAccount(page, 'link-e2e');
  const suffix = `${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  const target = `line-anchor-target-${suffix}`;
  // 行 ID は knot の行 ID と同じ ULID にする（#297）。
  const lineId = ulid();
  const created = await page.request.post(`/api/knot/pages/e2e/${target}/commits`, {
    headers: { 'X-Knot-Client': 'e2e' },
    data: {
      commitId: `${target}-create`,
      baseVersion: 0,
      ops: [
        { type: 'insert', id: `${target}-line-0`, after: '_head', text: target },
        { type: 'insert', id: `${target}-line-1`, after: `${target}-line-0`, text: 'first' },
        { type: 'insert', id: lineId, after: `${target}-line-1`, text: 'the linked line' },
      ],
    },
  });
  expect(created.ok()).toBe(true);
  const title = `line-anchor-source-${suffix}`;
  const body = [`[${target}#${lineId}]`, 'last body'];
  await createE2ePage(page, title, body);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/e2e/${title}`);
  const label = `${target}#${lineId.slice(-6)}`;
  const link = page.locator('#editor-root .line-row').nth(1).locator('a');
  await expect(link).toHaveText(label);
  await expect(link).toHaveAttribute('href', `/e2e/${target}#${lineId}`);
  await link.click();
  await expect(page).toHaveURL(`/e2e/${target}#${lineId}`);
  await expect(page.locator(`#L${lineId}`)).toHaveClass(/highlight/);

  // 編集表示の整形表示の行も、同じ字で描く。
  await page.goto(`/e2e/${title}`);
  await startEditingAtLastRow(page, body.length);
  await expect(page.locator('#editor-root .cm-line').nth(1).locator('a')).toHaveText(label);
});

test('外部リンクと別のプロジェクトへのリンクは、Cosense と同じく新しいタブで開く', async ({ page }, testInfo) => {
  // line-e2e はこの spec の login が多く、login の rate limit（10 分間に 10 回）に届くので、リンクの題材の account を使う。
  await loginE2eAccount(page, 'link-e2e');
  const suffix = `${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  const title = `line-new-tab-${suffix}`;
  const body = ['[https://example.com 外部] と [/e2e-related/rel-alpha]', 'last body'];
  await createE2ePage(page, title, body);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/e2e/${title}`);
  // 別のプロジェクトへのリンクは、ページへのリンクと同じ見た目（#287）。
  const expected: AnchorLook[] = [
    { text: '外部', href: 'https://example.com', target: '_blank', rel: 'noopener noreferrer', color: 'rgb(61, 114, 245)', decoration: 'underline' },
    {
      text: '/e2e-related/rel-alpha',
      href: '/e2e-related/rel-alpha',
      target: '_blank',
      rel: 'noopener noreferrer',
      color: 'rgb(61, 114, 245)',
      decoration: 'none',
    },
  ];
  expect(await anchorLooks(page, 1)).toEqual(expected);

  // 押すと新しいタブで開き、このページは閲覧表示のまま残る。
  const opened = page.waitForEvent('popup');
  await page.locator('#editor-root .line-row').nth(1).locator('a').nth(1).click();
  const popup = await opened;
  await expect(popup).toHaveURL(/\/e2e-related\/rel-alpha$/);
  await popup.close();
  await expect(page).toHaveURL(`/e2e/${title}`);
  await expect(page.locator('#editor-root .cm-editor')).toHaveCount(0);

  // 編集表示の整形表示の行も同じリンク。カーソル行では、別のプロジェクトへのリンクはページへのリンクの色。
  await startEditingAtLastRow(page, body.length);
  expect(await anchorLooks(page, 1)).toEqual(expected);
  const row = page.locator('#editor-root .cm-line').nth(1);
  const rowBox = (await row.boundingBox())!;
  await page.mouse.click(rowBox.x + rowBox.width - 8, rowBox.y + 8);
  await expect(row.locator('a')).toHaveCount(0);
  expect(await row.locator('[class*="cm-sb-"]').evaluateAll((spans) => spans.map((span) => [span.textContent, getComputedStyle(span).color])))
    .toEqual([['[https://example.com 外部]', 'rgb(120, 30, 122)'], ['[/e2e-related/rel-alpha]', 'rgb(61, 114, 245)']]);
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

type CursorLook = { text: string; fontSize: string; fontWeight: string; fontStyle: string; textDecoration: string };

// カーソル行の原文表示で、text を含む字の並びの見た目。
async function cursorLook(page: Page, row: number, text: string): Promise<CursorLook> {
  return page.locator('#editor-root .cm-line').nth(row).evaluate((line, target) => {
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (!(node instanceof Text) || !node.data.includes(target) || node.parentElement === null) continue;
      const style = getComputedStyle(node.parentElement);
      return {
        text: node.data,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        fontStyle: style.fontStyle,
        textDecoration: style.textDecorationLine,
      };
    }
    throw new Error(`${target} is missing`);
  }, text);
}

test('カーソル行でも、強調の段階・重ねた装飾を記法の字ごと閲覧表示と同じ形で描き、行の高さを変えない', async (
  { page },
  testInfo,
) => {
  await loginE2eAccount(page, 'active-line-e2e');
  const title = `line-cursor-strong-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  const body = ['[**** 四段の見出し]', '[-/*** 打ち消し斜体]', '[** [linked page] と二段]', 'last body'];
  await createE2ePage(page, title, body);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/e2e/${title}`);
  // 四段と三段の行の高さは、Cosense のカーソル行で測った高さと同じ。
  const heights = await rowHeights(page);
  expect(heights.slice(1, 3)).toEqual([42, 35]);

  // Cosense のカーソル行と同じく、[ と記号も装飾の大きさと形で描く（#267）。
  await page.locator('#editor-root .line-row').nth(1).click({ position: lineRowClickPosition });
  await expect(page.locator('#editor-root .cm-content')).toBeFocused();
  expect(await cursorLook(page, 1, '[****')).toEqual({
    text: '[**** 四段の見出し]', fontSize: '25.95px', fontWeight: '700', fontStyle: 'normal', textDecoration: 'none',
  });
  expect(await rowHeights(page)).toEqual(heights);

  await page.keyboard.press('ArrowDown');
  expect(await cursorLook(page, 2, '[-/***')).toEqual({
    text: '[-/*** 打ち消し斜体]', fontSize: '21.6px', fontWeight: '700', fontStyle: 'italic', textDecoration: 'line-through',
  });
  expect(await rowHeights(page)).toEqual(heights);

  // 装飾の中のリンクも、装飾の大きさと太さで描く。
  await page.keyboard.press('ArrowDown');
  expect(await cursorLook(page, 3, '[linked page]')).toEqual({
    text: '[linked page]', fontSize: '18px', fontWeight: '700', fontStyle: 'normal', textDecoration: 'none',
  });
  expect(await rowHeights(page)).toEqual(heights);
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

// 行（row 番目）の text の first 字目の左端。
async function charLeft(page: Page, selector: string, row: number, text: string): Promise<number> {
  return page.locator(selector).nth(row).evaluate((line, target) => {
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (!(node instanceof Text)) continue;
      const index = node.data.indexOf(target);
      if (index === -1) continue;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + 1);
      return Math.round(range.getBoundingClientRect().left * 2) / 2;
    }
    throw new Error(`${target} is missing`);
  }, text);
}

test('カーソル行でも、引用の枠とコードブロックの帯・札を閲覧表示と同じに描き、字の位置と行の高さを変えない', async (
  { page },
  testInfo,
) => {
  await loginE2eAccount(page, 'active-line-e2e');
  const title = `line-cursor-blocks-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  await createE2ePage(page, title, BLOCK_BODY);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/e2e/${title}`);
  const heights = await rowHeights(page);
  const rects = await visualLineRects(page);
  const looks = await blockLooks(page);
  // 行と、その行の字の位置を見る字。
  const textRows: Array<[number, string]> = [[2, 'top()'], [5, 'nested()'], [6, 'long_code'], [7, 'quoted'], [8, 'indented']];
  const lefts = new Map<number, number>();
  for (const [row, text] of textRows) lefts.set(row, await charLeft(page, '#editor-root .line-row', row, text));

  await startEditingAtLastRow(page, BLOCK_BODY.length);
  const putCursorOn = async (row: number, text: string): Promise<void> => {
    const point = await charPoint(page.locator('#editor-root .cm-line').nth(row), text, 0, 0.5);
    await page.mouse.click(point.x, point.y);
    await expect(page.locator('#editor-root .cm-line').nth(row)).not.toHaveClass(/cm-wysiwyg/);
  };
  const background = async (row: number): Promise<string> => page.locator('#editor-root .cm-line').nth(row)
    .evaluate((line) => getComputedStyle(line).backgroundImage);

  // コードブロックの見出しは、code: も閲覧表示と同じ札の中に見せる（#269）。
  for (const row of [1, 4]) {
    await putCursorOn(row, '.js');
    expect((await blockLooks(page))[row]!.label).toEqual(looks[row]!.label);
    expect(await rowHeights(page)).toEqual(heights);
  }
  // コードブロックの本文は、見出しの段から帯を引き、字は帯の中の同じ位置に置く。
  for (const [row, depth] of [[2, 0], [5, 1]] as const) {
    await putCursorOn(row, row === 2 ? 'top' : 'nested');
    expect(await background(row)).toBe(`linear-gradient(to right, rgba(0, 0, 0, 0) ${INDENT * depth}px, rgba(0, 0, 0, 0.04) ${INDENT * depth}px)`);
    expect(await charLeft(page, '#editor-root .cm-line', row, row === 2 ? 'top()' : 'nested()')).toBe(lefts.get(row));
    expect(await rowHeights(page)).toEqual(heights);
  }
  // 折り返した長いコードの行も、字は閲覧表示と同じ 1 行目の位置から始まり、同じ位置で折り返す。
  await putCursorOn(6, 'long_code');
  expect(await charLeft(page, '#editor-root .cm-line', 6, 'long_code')).toBe(lefts.get(6));
  expect((await visualLineRects(page))[6]).toEqual(rects[6]);
  expect(await rowHeights(page)).toEqual(heights);
  // 引用は字下げの位置から枠を引き、> は閲覧表示で見えない > と同じ位置に置く。
  for (const [row, depth] of [[7, 0], [8, 1]] as const) {
    await putCursorOn(row, row === 7 ? 'quoted' : 'indented');
    const left = INDENT * depth;
    expect(await background(row)).toBe(
      `linear-gradient(to right, rgba(0, 0, 0, 0) ${left}px, rgb(160, 160, 160) ${left}px, rgb(160, 160, 160) ${left + 1}px, rgba(0, 0, 0, 0.05) ${left + 1}px)`,
    );
    expect(await charLeft(page, '#editor-root .cm-line', row, row === 7 ? 'quoted' : 'indented')).toBe(lefts.get(row));
    expect(await rowHeights(page)).toEqual(heights);
  }
});

// 表の行ごとの、セルの幅と字の幅。
async function tableColumns(page: Page): Promise<Array<Array<{ cell: number; text: number }>>> {
  return page.evaluate(() => Array.from(
    document.querySelectorAll('#editor-root table'),
    (table) => Array.from(table.querySelectorAll('td'), (cell) => {
      const range = document.createRange();
      range.selectNodeContents(cell);
      return {
        cell: Math.round(cell.getBoundingClientRect().width * 2) / 2,
        text: range.getBoundingClientRect().width,
      };
    }),
  ));
}

test('表の列の幅を Cosense と同じく行のあいだで揃え、編集を始めても、セルを書き換えても揃える', async ({ page }, testInfo) => {
  await loginE2eAccount(page, 'table-e2e');
  const title = `line-table-columns-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  const body = ['table:sample', ' a\tbb', ' ccccc\td', 'last body'];
  await createE2ePage(page, title, body);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/e2e/${title}`);
  // 列ごとに、いちばん長いセルの字の幅にセルの padding（左 8px・右 2px）を足した幅で揃える（#276）。
  const read = await tableColumns(page);
  expect(read).toHaveLength(2);
  for (const column of [0, 1]) {
    const widest = Math.max(read[0]![column]!.text, read[1]![column]!.text);
    expect(read.map((row) => row[column]!.cell)).toEqual([0, 1].map(() => Math.round((widest + 10) * 2) / 2));
  }
  const widths = read.map((row) => row.map(({ cell }) => cell));

  // 編集を始めても、列の幅は変わらない。
  await startEditingAtLastRow(page, body.length);
  expect((await tableColumns(page)).map((row) => row.map(({ cell }) => cell))).toEqual(widths);

  // 表の行に caret を入れても、ほかの行の列の幅は狭くならない。セルを長くすると、caret が
  // 出た後で、その列は行のあいだで揃ったまま広がる。
  await page.locator('#editor-root .cm-line').nth(2).click({ position: { x: 60, y: 8 } });
  await page.keyboard.press('End');
  await page.keyboard.press('Home');
  await expect(page.locator('#editor-root .cm-line').nth(2).locator('table')).toHaveCount(0);
  expect((await tableColumns(page)).map((row) => row.map(({ cell }) => cell))).toEqual([widths[1]]);
  await page.keyboard.insertText('wide-cell-');
  await page.locator('#editor-root .cm-line').nth(4).click({ position: { x: 60, y: 8 } });
  // 編集表示は CodeMirror の計測（次の描画の前）で列の幅を測り直す。
  await expect.poll(async () => {
    const [first, second] = await tableColumns(page);
    return first !== undefined && second !== undefined && first[0]!.cell === second[0]!.cell;
  }).toBe(true);
  const edited = await tableColumns(page);
  expect(edited[0]![0]!.cell).toBe(edited[1]![0]!.cell);
  expect(edited[0]![0]!.cell).toBe(Math.round((Math.max(edited[0]![0]!.text, edited[1]![0]!.text) + 10) * 2) / 2);
  expect(edited[0]![0]!.cell).toBeGreaterThan(widths[0]![0]!);
});

type Box = { x: number; y: number; width: number; height: number };

function roundBox(box: Box): Box {
  return { x: Math.round(box.x * 2) / 2, y: Math.round(box.y * 2) / 2, width: Math.round(box.width * 2) / 2, height: Math.round(box.height * 2) / 2 };
}

test('カーソル行でも、表のセルの箱と見出しの点・札を閲覧表示と同じ位置に描き、行の高さを変えない', async ({ page }, testInfo) => {
  await loginE2eAccount(page, 'table-e2e');
  const title = `line-table-cursor-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  const body = [' table:sample', '  a\tbb', '  ccccc\td', 'last body'];
  await createE2ePage(page, title, body);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/e2e/${title}`);
  const heights = await rowHeights(page);
  const readCells = await page.locator('#editor-root table').evaluateAll((tables) => tables.map((table) => Array.from(
    table.querySelectorAll('td'),
    (cell) => { const { x, y, width, height } = cell.getBoundingClientRect(); return { x, y, width, height }; },
  )));
  const readLabel = (await page.locator('#editor-root .table-block-start').boundingBox())!;

  await startEditingAtLastRow(page, body.length);
  const rows = page.locator('#editor-root .cm-line');
  // 表の行に caret を入れても、セルは td と同じ位置と大きさの箱のまま。背景だけを少し濃くする（#293）。
  const cellPoint = await charPoint(rows.nth(2), 'b', 1, 0.2);
  await page.mouse.click(cellPoint.x, cellPoint.y);
  await expect(rows.nth(2)).not.toHaveClass(/cm-wysiwyg/);
  const cells = await rows.nth(2).locator('.cm-table-cell').evaluateAll((spans) => spans.map((span) => {
    const { x, y, width, height } = span.getBoundingClientRect();
    return { box: { x, y, width, height }, text: span.textContent, background: getComputedStyle(span).backgroundColor };
  }));
  expect(cells.map(({ box }) => roundBox(box))).toEqual(readCells[0]!.map(roundBox));
  expect(cells.map(({ text, background }) => [text, background])).toEqual([['a', 'rgba(0, 0, 0, 0.06)'], ['bb', 'rgba(0, 0, 0, 0.08)']]);
  expect(await rows.nth(2).locator('.cm-table-gap').evaluateAll((gaps) => gaps.map((gap) => gap.getBoundingClientRect().width))).toEqual([0, 0]);
  expect(await rowHeights(page)).toEqual(heights);
  // セルの中の字は、これまでどおり書き換えられる。
  await page.keyboard.insertText('X');
  await expect(rows.nth(2)).toHaveText('  a\tbXb');

  // 表の見出しは、字下げの点と札を保ち、札の中に table: も見せる。
  const headerPoint = await charPoint(rows.nth(1), 's', 0, 0.5);
  await page.mouse.click(headerPoint.x, headerPoint.y);
  await expect(rows.nth(1)).toHaveClass(/cm-active-indent/);
  await expect(rows.nth(1)).toHaveClass(/mark-dot/);
  const label = rows.nth(1).locator('.table-block-start');
  await expect(label).toHaveText('table:sample');
  expect(Math.round((await label.boundingBox())!.x * 2) / 2).toBe(Math.round(readLabel.x * 2) / 2);
  expect(await rowHeights(page)).toEqual(heights);
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
  // 行頭の印は、カーソル行の ::before（#271）。
  const mark = await page.locator('#editor-root .cm-line').nth(rowIndex).evaluate((row) => {
    const style = getComputedStyle(row, '::before');
    if (style.content === 'none') return null;
    const box = row.getBoundingClientRect();
    return {
      x: Math.round((box.left + Number.parseFloat(style.left)) * 2) / 2,
      y: Math.round(Number.parseFloat(style.top) * 2) / 2,
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

test('カーソル行のコードブロックの本文の先頭でも、IME の変換中の字を確定後と同じ幅で描き、確定して保存できる', async (
  { page },
  testInfo,
) => {
  await loginE2eAccount(page, 'active-line-e2e');
  const title = `line-active-code-ime-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  await createE2ePage(page, title, ['code:a.js', ' code()', 'last body']);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/e2e/${title}`);
  await startEditingAtLastRow(page, 3);
  const code = page.locator('#editor-root .cm-line').nth(2);
  await code.click({ position: { x: 300, y: 8 } });
  await page.keyboard.press('Home');
  const width = async (text: string): Promise<number> => code.evaluate((line, target) => {
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (!(node instanceof Text)) continue;
      const index = node.data.indexOf(target);
      if (index === -1) continue;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + target.length);
      return Math.round(range.getBoundingClientRect().width);
    }
    throw new Error(`${target} is missing`);
  }, text);

  // 変換中の字は、行頭の空白（1 字を 1 段の幅で描く）と同じ text に入るが、空白のようには広げない（#269）。
  const cdp = await page.context().newCDPSession(page);
  for (const text of ['に', 'にほ']) {
    await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
  }
  const composing = await width('にほ');
  await cdp.send('Input.insertText', { text: 'にほ' });
  await expect(code).toHaveText(' にほcode()');
  expect(composing).toBe(await width('にほ'));

  await expect(page.locator('#save-status')).toHaveText('保存済み');
  const persisted = await page.request.get(`/api/pages/e2e/${title}`);
  expect((await persisted.json()).lines.map((line: { text: string }) => line.text)).toEqual([title, 'code:a.js', ' にほcode()', 'last body']);
});

test('字下げした行が長い 1 語で始まっても、カーソル行の字は閲覧表示と同じ 1 行目から始まり、行の高さを変えない', async (
  { page },
  testInfo,
) => {
  await loginE2eAccount(page, 'active-line-e2e');
  const title = `line-active-long-word-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  // 空白を含まない長い 1 語（長い URL など）で始まる行。
  const body = [` ${'abcdefghij'.repeat(40)}`, `  ${'0123456789'.repeat(30)} tail`, 'last body'];
  await createE2ePage(page, title, body);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/e2e/${title}`);
  const heights = await rowHeights(page);
  const rects = await visualLineRects(page);
  const marks = await indentMarks(page);

  await startEditingAtLastRow(page, body.length);
  for (const rowIndex of [1, 2]) {
    await page.locator('#editor-root .cm-line').nth(rowIndex).click({ position: { x: 60, y: 8 } });
    await expect(page.locator('#editor-root .cm-line').nth(rowIndex).locator('.cm-wysiwyg-line')).toHaveCount(0);
    // 字は閲覧表示と同じ位置から始まり、同じ位置で折り返す（#271）。
    expect((await visualLineRects(page))[rowIndex]).toEqual(rects[rowIndex]);
    expect(await rowHeights(page)).toEqual(heights);
    const formatted = marks[rowIndex]!;
    expect((await activeLineLook(page, rowIndex)).mark).toEqual({ x: formatted.textLeft + formatted.mark!.x, y: formatted.mark!.y });
  }
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

  // Enter で作った字下げだけの行で始めた変換中の字も、字下げの位置から、確定後と同じ大きさで描く
  // （#271。変換中の字は字下げの空白と同じ text に入る）。
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  expect(await page.locator('#editor-root .cm-line').nth(2).evaluate((line) => line.textContent)).toBe(' ');
  const box = async (): Promise<number[]> => page.locator('#editor-root .cm-line').nth(2).evaluate((line) => {
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (!(node instanceof Text)) continue;
      const index = node.data.indexOf('にほ');
      if (index === -1) continue;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + 2);
      const rect = range.getBoundingClientRect();
      return [Math.round(rect.left), Math.round(rect.width)];
    }
    throw new Error('にほ is missing');
  });
  for (const text of ['に', 'にほ']) {
    await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
  }
  const composing = await box();
  await cdp.send('Input.insertText', { text: 'にほ' });
  await expect(page.locator('#editor-root .cm-line').nth(2)).toHaveText(' にほ');
  expect(composing).toEqual(await box());
  expect(composing[0]).toBe(textLeftBefore);

  await expect(page.locator('#save-status')).toHaveText('保存済み');
  const persisted = await page.request.get(`/api/pages/e2e/${title}`);
  expect((await persisted.json()).lines.map((line: { text: string }) => line.text).slice(1, 3)).toEqual([' 日本一段目の行', ' にほ']);
});
