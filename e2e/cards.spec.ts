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

// 札（.card）の並びと中身。位置と大きさは 0.1px 単位に丸める。
async function cards(page: Page, gridSelector: string): Promise<Card[]> {
  return page.locator(`${gridSelector} > li`).evaluateAll((items) => items.map((item) => {
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
  title: { fontSize: '13px', fontWeight: '700', lineHeight: '20px', color: 'rgb(54, 60, 73)', padding: '10px 12px' },
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
  const related = await cards(page, '.related-pages .card-grid');
  // 紙面の幅 960px に 6 列。列幅は (960 - 16 * 5) / 6、高さはその 1.1 倍。
  expect(related[0]).toMatchObject({ x: 132, width: 146.7, height: 161.3 });
});
