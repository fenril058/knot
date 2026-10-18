import { test, expect, type Page } from '@playwright/test';
import { createE2ePage, loginE2eAccount } from './helpers.ts';

type Card = {
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  hasImage: boolean;
  descriptions: number;
};

// 札（.card）の並びと中身。位置と大きさは 0.1px 単位に丸める。関連ページの行の先頭の見出しの札は除く。
async function cards(page: Page, gridSelector: string): Promise<Card[]> {
  return page.locator(`${gridSelector} > li:not(.relation-label)`).evaluateAll((items) => items.map((item) => {
    const card = item.querySelector('.card');
    if (card === null) throw new Error('card is missing');
    const box = item.getBoundingClientRect();
    const [x, y, width, height] = [box.left, box.top, box.width, box.height]
      .map((value) => Math.round(value * 10) / 10);
    return {
      title: card.querySelector('h2, h3')?.textContent ?? '',
      x: x!,
      y: y!,
      width: width!,
      height: height!,
      hasImage: card.querySelector('img') !== null,
      descriptions: card.querySelectorAll('p').length,
    };
  }));
}

// Cosense の既定テーマで測った札の見た目（#233）。
const CARD_LOOK = {
  background: 'rgb(255, 255, 255)',
  radius: '2px',
  shadow: 'rgba(0, 0, 0, 0.12) 0px 2px 0px 0px',
  topBand: '4px solid rgb(242, 242, 243)',
  // Cosense はタイトルの外側の要素に padding 10px 12px を持つ。knot は下の 10px を margin にする（#249）。
  title: { fontSize: '13px', fontWeight: '700', lineHeight: '20px', color: 'rgb(54, 60, 73)', padding: '10px 12px 0px', marginBottom: '10px' },
  description: { fontSize: '12px', lineHeight: '20px', color: 'rgb(128, 128, 128)' },
};

async function cardLook(page: Page, title: string): Promise<typeof CARD_LOOK> {
  const card = page.locator('.card', { has: page.locator(`h2:text-is("${title}"), h3:text-is("${title}")`) });
  return card.evaluate((element) => {
    const style = getComputedStyle(element);
    const heading = element.querySelector('h2, h3');
    if (heading === null) throw new Error('card title is missing');
    const titleStyle = getComputedStyle(heading);
    const description = element.querySelector('p');
    const descriptionStyle = description === null ? null : getComputedStyle(description);
    return {
      background: style.backgroundColor,
      radius: style.borderRadius,
      shadow: style.boxShadow,
      // Cosense と同じく、札の上端の帯はタイトルの border として描かれる。
      topBand: titleStyle.borderTop,
      title: {
        fontSize: titleStyle.fontSize,
        fontWeight: titleStyle.fontWeight,
        lineHeight: titleStyle.lineHeight,
        color: titleStyle.color,
        padding: titleStyle.padding,
        marginBottom: titleStyle.marginBottom,
      },
      description: descriptionStyle === null
        ? { fontSize: '', lineHeight: '', color: '' }
        : { fontSize: descriptionStyle.fontSize, lineHeight: descriptionStyle.lineHeight, color: descriptionStyle.color },
    };
  });
}

function svg(width: number, height: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#89a"/></svg>`;
}

async function createProject(page: Page, name: string): Promise<void> {
  const response = await page.request.post(`/api/knot/projects/${name}`, { headers: { 'X-Knot-Client': 'e2e' } });
  expect(response.ok()).toBe(true);
}

async function createPageIn(page: Page, project: string, title: string, body: string[]): Promise<void> {
  const ops = [title, ...body].map((text, index) => ({
    type: 'insert' as const,
    id: `${project}-${title}-${index}`,
    after: index === 0 ? '_head' : `${project}-${title}-${index - 1}`,
    text,
  }));
  const response = await page.request.post(`/api/knot/pages/${project}/${encodeURIComponent(title)}/commits`, {
    headers: { 'X-Knot-Client': 'e2e' },
    data: { commitId: `${project}-${title}-create`, baseVersion: 0, ops },
  });
  expect(response.ok()).toBe(true);
}

test('一覧の札を Cosense と同じ列幅・間隔・縦横比で並べ、画像か説明文のどちらかを置く', async ({ page }, testInfo) => {
  await loginE2eAccount(page, 'cards-e2e');
  const project = `cards-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  await createProject(page, project);
  await page.route('https://i.gyazo.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/svg+xml', body: svg(400, 300) })
  );
  await createPageIn(page, project, 'text card', ['説明の一行目', '説明の二行目']);
  await createPageIn(page, project, 'image card', ['https://i.gyazo.com/card.png', '画像のあるページの説明']);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/${project}`);
  const listed = await cards(page, 'main > .card-grid');
  // 1280px の一覧は幅 1184px に 7 列。列幅は (1184 - 16 * 6) / 7、高さはその 1.1 倍。
  expect(listed.map(({ x, width, height }) => ({ x, width, height }))).toEqual([
    { x: 48, width: 155.4, height: 171 },
    { x: 219.4, width: 155.4, height: 171 },
  ]);
  expect(listed.find((card) => card.title === 'image card')).toMatchObject({ hasImage: true, descriptions: 0 });
  expect(listed.find((card) => card.title === 'text card')).toMatchObject({ hasImage: false, descriptions: 2 });
  expect(await cardLook(page, 'text card')).toEqual(CARD_LOOK);

  // hover できる環境では札が少し暗くなり、影が濃くなる。
  const textCard = page.locator('.card', { has: page.locator('h2:text-is("text card")') });
  await textCard.hover();
  await expect(textCard).toHaveCSS('box-shadow', 'rgba(0, 0, 0, 0.23) 0px 2px 0px 0px');
  await expect.poll(() => textCard.evaluate((element) => getComputedStyle(element, '::after').backgroundColor))
    .toBe('rgba(0, 0, 0, 0.05)');
});

test('ピン留めしたページの札だけ右上が折り返る', async ({ page }) => {
  await loginE2eAccount(page, 'cards-e2e');
  await page.setViewportSize({ width: 1280, height: 800 });
  // e2e/server.ts が用意する、ピン留めのページを含むプロジェクト。
  await page.goto('/e2e-pinned');
  const corner = async (title: string): Promise<{ width: string; height: string; image: string }> =>
    page.locator('.card', { has: page.locator(`h2:text-is("${title}")`) }).evaluate((element) => {
      const style = getComputedStyle(element, '::before');
      return { width: style.width, height: style.height, image: style.backgroundImage };
    });
  const pinned = await corner('pinned card');
  expect({ width: pinned.width, height: pinned.height }).toEqual({ width: '14px', height: '14px' });
  expect(pinned.image).toContain('linear-gradient');
  expect((await corner('plain card')).image).toBe('none');
});

test('関連ページの札は紙面の幅に Cosense と同じ列幅で並ぶ', async ({ page }, testInfo) => {
  await loginE2eAccount(page, 'cards-e2e');
  const suffix = `${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  const hub = `cards-hub-${suffix}`;
  const title = `cards-related-${suffix}`;
  await createE2ePage(page, hub, ['hub body']);
  await createE2ePage(page, `${title}-other`, [`[${hub}]`]);
  await createE2ePage(page, title, [`[${hub}]`]);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/e2e/${title}`);
  const related = await cards(page, '.related-pages .related-group');
  // 紙面の幅 960px に 6 列。列幅は (960 - 16 * 5) / 6、高さはその 1.1 倍。1 列目は見出しの札（#249）。
  expect(related[0]).toMatchObject({ x: 132 + 146.7 + 16, width: 146.7, height: 161.3 });
});

type Label = {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  background: string;
  color: string;
  href: string | null;
  arrow: { width: string; color: string; halfHeight: string; atRightEdge: boolean; centered: boolean };
};

// 見出しの札の右端の中央に付ける、札の色の右向きの三角（幅 5px・高さ 14px）。
function labelArrow(color: string): Label['arrow'] {
  return { width: '5px', color, halfHeight: '7px', atRightEdge: true, centered: true };
}

// 関連ページの行の先頭の見出しの札（#249）。位置と大きさは 0.1px 単位に丸める。
async function relatedLabels(page: Page): Promise<Label[]> {
  return page.locator('.related-group > li.relation-label').evaluateAll((items) => items.map((item) => {
    const card = item.querySelector('.relation-label-card');
    if (card === null) throw new Error('label card is missing');
    const box = item.getBoundingClientRect();
    const [x, y, width, height] = [box.left, box.top + window.scrollY, box.width, box.height]
      .map((value) => Math.round(value * 10) / 10);
    const style = getComputedStyle(card);
    const arrow = getComputedStyle(item, '::after');
    return {
      text: card.textContent?.trim() ?? '',
      x: x!,
      y: y!,
      width: width!,
      height: height!,
      background: style.backgroundColor,
      color: style.color,
      href: card.getAttribute('href'),
      arrow: {
        width: arrow.borderLeftWidth,
        color: arrow.borderLeftColor,
        halfHeight: arrow.borderTopWidth,
        atRightEdge: Math.abs(Number.parseFloat(arrow.left) - box.width) < 0.5,
        centered: Math.abs(Number.parseFloat(arrow.top) - (box.height - 14) / 2) < 0.5,
      },
    };
  }));
}

test('関連ページを、Links の札と共有するリンク先ごとの行に並べる', async ({ page }, testInfo) => {
  await loginE2eAccount(page, 'cards-e2e');
  const suffix = `${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  const hub = `group-hub-${suffix}`;
  const title = `group-page-${suffix}`;
  await createE2ePage(page, hub, ['リンク先のページ']);
  await createE2ePage(page, `group-other-${suffix}`, [`[${hub}] を共有するページ`]);
  await createE2ePage(page, title, [`[${hub}] へのリンク`]);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/e2e/${title}`);
  const labels = await relatedLabels(page);
  // 1-hop の行は青い「Links」、2-hop の行は共有するリンク先の名前の札で始まり、それぞれ新しい行から
  // 始まる。行の間は 40px。札の右端の中央に、札の色の右向きの三角（幅 5px・高さ 14px）を付ける。
  const top = labels[0]!.y;
  expect(labels).toEqual([
    {
      text: 'Links', x: 132, y: top, width: 146.7, height: 161.3,
      background: 'rgb(61, 114, 245)', color: 'rgb(255, 255, 255)', href: null, arrow: labelArrow('rgb(61, 114, 245)'),
    },
    {
      text: hub, x: 132, y: Math.round((top + 161.3 + 40) * 10) / 10, width: 146.7, height: 161.3,
      background: 'rgb(155, 171, 193)', color: 'rgb(255, 255, 255)', href: `/e2e/${hub}`, arrow: labelArrow('rgb(155, 171, 193)'),
    },
  ]);
  await expect(page.locator('.related-group').nth(1).locator('.card h3')).toHaveText([`group-other-${suffix}`]);
  // 見出しの文は画面に出さない。
  await expect(page.getByText('2-hop リンク')).toHaveCount(0);
  await expect(page.getByText('逆リンクまたはアイコン参照あり')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '関連ページ', level: 2 })).toHaveClass('visually-hidden');
});

test('札のタイトルは 3 行で切り、4 行目を札の中に覗かせない', async ({ page }, testInfo) => {
  await loginE2eAccount(page, 'cards-e2e');
  const suffix = `${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  const longTitle = `long-title-${suffix}-${'とても長いタイトルの札'.repeat(4)}`;
  const title = `long-title-page-${suffix}`;
  await createE2ePage(page, longTitle, ['本文']);
  await createE2ePage(page, title, [`[${longTitle}]`]);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/e2e/${title}`);
  const heading = page.locator('.card h3', { hasText: `long-title-${suffix}-` });
  const lines = await heading.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(element);
    const tops = [...new Set(Array.from(range.getClientRects(), (rect) => Math.round(rect.top)))].toSorted((a, b) => a - b);
    return { bottom: Math.round(box.bottom), tops };
  });
  // 4 行以上ある。3 行目までは見え、4 行目は札のタイトルの箱の下端から始まる（箱の外なので見えない）。
  expect(lines.tops.length).toBeGreaterThanOrEqual(4);
  expect(lines.tops[3]!).toBeGreaterThanOrEqual(lines.bottom);
});

test('プロジェクトのトップは見出しを出さず、札の上の toolbar に新規作成、右下にページ数を置く', async ({ page }, testInfo) => {
  await loginE2eAccount(page, 'cards-e2e');
  const project = `top-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  await createProject(page, project);
  await createPageIn(page, project, 'first card', ['本文']);
  await createPageIn(page, project, 'second card', ['本文']);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/${project}`);
  // 見出しは支援技術にだけ伝える（#253）。
  await expect(page.getByRole('heading', { level: 1, name: project })).toHaveClass('visually-hidden');
  // 新規作成は Cosense の toolbar のボタンと同じ見た目で、右端の並び替えの展開ボタン（#291）の左に置く。札は y=110 から。
  const button = page.locator('#create-page-button');
  const buttonBox = (await button.boundingBox())!;
  const sortToggleBox = (await page.locator('.page-sort-menu .sort-menu-toggle').boundingBox())!;
  expect(Math.round(sortToggleBox.x + sortToggleBox.width)).toBe(48 + 1184);
  expect(Math.round(buttonBox.x + buttonBox.width)).toBe(Math.round(sortToggleBox.x));
  expect(await button.evaluate((element) => {
    const style = getComputedStyle(element);
    return { color: style.color, fontSize: style.fontSize, padding: style.padding, background: style.backgroundColor, radius: style.borderRadius };
  })).toEqual({ color: 'rgb(54, 60, 73)', fontSize: '14px', padding: '6px 10px 3px', background: 'rgba(0, 0, 0, 0)', radius: '3px' });
  expect(Math.round((await page.locator('main > .card-grid > li').first().boundingBox())!.y)).toBe(110);
  // ページ数は画面の右下に置く。
  const status = page.locator('.page-list-status');
  await expect(status).toHaveText('2 pages');
  const statusBox = (await status.boundingBox())!;
  expect({ right: Math.round(statusBox.x + statusBox.width), bottom: Math.round(statusBox.y + statusBox.height) })
    .toEqual({ right: 1280, bottom: 800 });

  // 新規作成の dialog から、入れたタイトルのページを開く。
  await button.click();
  await page.locator('#create-page-title').fill('third card');
  await page.locator('#create-page-form button[type="submit"]').click();
  await expect(page).toHaveURL(`/${project}/third_card`);
});

test('プロジェクトのトップの並び替えの menu で、ページを選んだ順に並べ、選んだ並び替えを残す', async ({ page }) => {
  await loginE2eAccount(page, 'cards-e2e');
  await page.setViewportSize({ width: 1280, height: 800 });
  // e2e-related のページは e2e/server.ts が用意する。
  await page.goto('/e2e-related');
  const toolbar = (await page.locator('.page-list-toolbar').boundingBox())!;
  const toggle = page.locator('.page-sort-menu .sort-menu-toggle');
  const toggleBox = (await toggle.boundingBox())!;
  // Cosense と同じく、展開ボタンは toolbar の右端で、42px の行の上から 4.8px（#291）。
  expect(toggleBox.x + toggleBox.width).toBeCloseTo(toolbar.x + toolbar.width, 1);
  expect(toggleBox.y).toBeCloseTo(toolbar.y + 4.8, 1);
  expect(toggleBox.height).toBe(35);
  await expect(page.locator('.page-sort-menu .sort-menu-current')).toHaveText('更新日時');

  await toggle.click();
  const options = page.locator('.page-sort-menu .sort-menu-options');
  const menu = (await options.boundingBox())!;
  expect({ right: menu.x + menu.width, width: menu.width }).toEqual({ right: toggleBox.x + toggleBox.width, width: 160 });
  expect(menu.y).toBeCloseTo(toolbar.y + 44, 1);
  await expect(options.locator('a')).toHaveText(['更新日時', '作成日時', '最終アクセス', '被リンク数', '閲覧数', 'タイトル']);
  // Escape で閉じ、展開ボタンへ focus を戻す。
  await page.keyboard.press('Escape');
  await expect(page.locator('.page-sort-menu')).not.toHaveAttribute('open');
  await expect(toggle).toBeFocused();

  await toggle.click();
  await options.locator('a', { hasText: 'タイトル' }).click();
  await expect(page).toHaveURL('/e2e-related?sort=title');
  const byTitle = ['rel-alpha', 'rel-base', 'rel-bravo', 'rel-charlie', 'rel-new', 'rel-solo', 'rel-two-yankee', 'rel-two-zulu'];
  await expect(page.locator('main > .card-grid .card h2')).toHaveText(byTitle);
  // 並び替えを指定せずに開き直しても、選んだ並び替えのまま。
  await page.goto('/e2e-related');
  await expect(page.locator('.page-sort-menu .sort-menu-current')).toHaveText('タイトル');
  await expect(page.locator('main > .card-grid .card h2')).toHaveText(byTitle);
});

test('札の説明文の中のリンク・URL・コードを Cosense と同じ色と形で描き、押すと札のページへ移る', async ({ page }, testInfo) => {
  await loginE2eAccount(page, 'cards-e2e');
  const project = `desc-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  await createProject(page, project);
  await createPageIn(page, project, 'described', ['[linked page] と https://example.com/ と `code` と [* bold]']);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/${project}`);
  const description = page.locator('.card', { has: page.locator('h2:text-is("described")') }).locator('p');
  const looks = await description.evaluate((paragraph) => {
    const style = (selector: string): Record<string, string> => {
      const element = paragraph.querySelector(selector);
      if (element === null) throw new Error(`${selector} is missing`);
      const computed = getComputedStyle(element);
      return {
        color: computed.color,
        decoration: computed.textDecorationLine,
        background: computed.backgroundColor,
        fontSize: computed.fontSize,
        radius: computed.borderRadius,
      };
    };
    return { link: style('.card-link'), url: style('.card-url'), code: style('code'), strong: paragraph.querySelector('strong') !== null };
  });
  // Cosense の札の説明文と同じ（#256）。装飾は付けない。
  expect(looks).toEqual({
    link: { color: 'rgb(57, 107, 221)', decoration: 'none', background: 'rgba(0, 0, 0, 0)', fontSize: '12px', radius: '0px' },
    url: { color: 'rgb(57, 107, 221)', decoration: 'underline', background: 'rgba(0, 0, 0, 0)', fontSize: '12px', radius: '0px' },
    code: { color: 'rgb(52, 45, 156)', decoration: 'none', background: 'rgba(0, 0, 0, 0.04)', fontSize: '10.8px', radius: '4px' },
    strong: false,
  });
  // 説明文の中のリンクを押しても、札のページへ移る。
  await description.locator('.card-url').click();
  await expect(page).toHaveURL(`/${project}/described`);
});
