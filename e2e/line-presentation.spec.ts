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
