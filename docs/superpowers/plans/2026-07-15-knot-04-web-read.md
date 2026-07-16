# knot plan-04 (web-read) Implementation Plan

> **完了済みの履歴資料です。**
> 本文中のチェックリストとコード断片を、新規実装の手順として実行してはいけません。
> 実装後に判明した訂正と最終判断は、文末の [Errata](#errata実装後レビューによる追記2026-07-16) を参照してください。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Save location:** this plan should be committed to `docs/superpowers/plans/2026-07-15-knot-04-web-read.md` before execution (writing-plans convention for this repo).

**Goal:** Deliver a browsable, read-only wiki: SSR page list (pinned cards), SSR page view (Cosense-notation renderer with XSS-safe HTML, telomere per-line recency/read bars, related pages, red links), a login page, and a simplified (non-fuzzy) search UI — reusing plan-03's JSON API and storage layer wherever possible.

**Architecture:** All server-rendered HTML is produced with `hono/html`'s `html`/`raw` tagged templates (auto-escaping), never JSX — the repo's `tsconfig.json` has `erasableSyntaxOnly: true` and no build step for the server, and JSX requires a transform that contradicts "type stripping only, no build". Client-side behavior (login POST with custom header, permalink scroll, telomere tooltip, search) is hand-written vanilla JS served as static files under `/assets/*` via `@hono/node-server/serve-static` — no bundler is introduced in this plan (esbuild stays reserved for plan-05's editor, per the user's explicit choice this session).

**Tech Stack:** Hono 4, `hono/html`, `@hono/node-server` (+ its `serve-static` subpackage, already a transitive dep of the installed `@hono/node-server@^2.0.8`), `@progfay/scrapbox-parser` (already a dependency), node:sqlite, vanilla ES2020+ browser JS (no TypeScript, no bundling) for `public/*.js`.

## Global Constraints

- Node.js >= 24, no build step for server code (`node --experimental-strip-types` / type-stripping only); client bundling stays out of scope until plan-05.
- No inline `<script>`, `<style>`, or `on*=` attributes anywhere in server-rendered HTML — CSP is `default-src 'self'` with no nonce, so all JS/CSS must be external files under `/assets/*`.
- Test with `direnv exec . npm test`; typecheck with `direnv exec . npx tsc --noEmit`. Both must pass before every commit.
- Reuse existing storage/core/server helpers listed below verbatim — do not reimplement `titleLc`, `classifyUrl`, `extractRefs`, `resolveProject`, `resolvePage`, `safeDecode`, `jsonError`, `pageToJson`, or the `register*Routes(app, deps)` pattern.
- Timestamps are Unix seconds; IDs are ULID (`src/core/id.ts`).
- Reserved project names (`api`, `login`, `files`, `assets`) are already enforced in `src/storage/sqlite.ts:38` (`RESERVED_PROJECT_NAMES`) — no new work needed there.

## Context

Plan-03 (merged, `main` = `5306f75`) delivered the full Cosense-compatible JSON API, auth/session, and write endpoints, but zero HTML. `src/render/` does not exist yet — no XSS-safe renderer, no templating of any kind. `page_visits` (needed for telomere read/unread) has a table in the schema but no storage-layer code touches it at all. This plan is the first to render bytes a browser shows a human, so it's also where the spec's XSS-safety requirements ("レンダリングと添付の安全化") become real: every user-authored line of wiki text becomes untrusted input to an HTML generator.

Two scope decisions were made explicit with the user before finalizing this plan:
1. **Search UI is simplified for v1**: title matching is plain case-insensitive substring (not fzf-style fuzzy subsequence matching), and no client bundler is introduced. The fuzzy-match upgrade is deferred to plan-05, when esbuild is introduced for the editor anyway.
2. Three small, additive storage changes are accepted as in-scope for this plan even though they touch plan-03-delivered files, because they're required for spec-mandated behavior and are backward compatible (new optional fields/params/methods, no removals): (a) `page_visits` read/write methods (table already existed, unused), (b) a `pinnedFirst` ordering option on `listPageSummaries` for the page-list route, (c) an `image` field added to `TitleEntry`/`search/titles` so `[Name.icon]` can render an actual thumbnail instead of bracket text, (d) a `setPinned(pageId, pinned)` write method — **verified there is currently no way anywhere in the codebase (no commit op, no import field, no API) to mark a page pinned**, so `pinned` is always `0` today; without this method, "pinned first" is unimplemented and untestable. This is a minimal, narrowly-scoped write method, not a UI — pinning UI/API exposure (e.g. a button) stays out of scope for this plan and is left for plan-05.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/storage/types.ts` (modify) | Add `Visit` type, `recordVisit`/`getVisit` to `Storage`; add `pinnedFirst?: boolean` to `ListPageSummariesOptions`; add `image: string \| null` to `TitleEntry` |
| `src/storage/sqlite.ts` (modify) | Implement the above against the existing `page_visits` table and `listPageTitles`/`listPageSummaries` queries |
| `src/render/render.ts` | Pure function: `Line[]` + known-pages map + `RenderConfig` → per-line HTML (`RenderedLine[]`), red-link detection, media/icon embedding, XSS-safe escaping (via `hono/html`) |
| `test/render/render.test.ts` | Golden tests for every AST node kind + XSS payloads |
| `src/server/app.ts` (modify) | Auth middleware: `GET /login` and `GET /assets/*` public; HTML routes redirect to `/login` instead of 401 JSON; mount `serveStatic` for `/assets/*`; register new page routes |
| `src/server/views/layout.ts` | Shared HTML shell (`<head>`, external `<link>`/`<script src>` only) via `hono/html` |
| `src/server/views/login.ts` | Login page view |
| `src/server/views/pageList.ts` | Page-list (card grid) view + search box markup |
| `src/server/views/pageView.ts` | Page-view (rendered body with telomere gutter, related pages) + "page not found / create" view |
| `src/server/routes/pages.ts` | `registerPageRoutes(app, deps)`: `GET /login`, `GET /:project`, `GET /:project/:title` |
| `public/app.css` | Minimal functional stylesheet (grid, telomere bars, red-link color) |
| `public/login.js` | POSTs credentials with `X-Knot-Client` header, redirects or shows error |
| `public/search.js` | Title substring filter (cached `search/titles` fetch) + 200ms-debounced full-text search |
| `public/line-ui.js` | Permalink scroll/highlight from `location.hash`, telomere hover (relative time) / click (exact time + editor) popover |
| `test/storage/page-visits.test.ts` | `recordVisit`/`getVisit` round-trip |
| `test/server/auth-html.test.ts` | Redirect-vs-401 behavior for HTML vs API routes |
| `test/server/assets.test.ts` | Static asset serving |
| `test/server/login-page.test.ts` | Login page markup, no-inline-script assertion |
| `test/server/pages-list.test.ts` | `GET /:project` — pinned-first, pagination, card content |
| `test/server/pages-view.test.ts` | `GET /:project/:title` — render, red link, telomere read/unread, related pages, 404 create-prompt |
| `test/server/web-read-e2e.test.ts` | One end-to-end walk: login → list → view → revisit → 404, plus a no-inline-content sweep over all fetched bodies |

Reused as-is (no changes): `src/core/title.ts` (`titleLc`, `encodeTitleForUrl`, `decodeTitleSegment`), `src/core/media.ts` (`classifyUrl`), `src/server/http.ts` (`resolveProject`, `resolvePage`, `safeDecode`, `jsonError`, `ApiEnv`), `test/helpers/server.ts` (`makeServer`), `test/helpers/pages.ts` (`seedPage`).

---

### Task 1: storage — `page_visits` (recordVisit / getVisit)

**Files:**
- Modify: `src/storage/types.ts`
- Modify: `src/storage/sqlite.ts`
- Test: `test/storage/page-visits.test.ts`

**Interfaces:**
```ts
// src/storage/types.ts
export type Visit = { visited: number; lastSeenVersion: number };
// interface Storage に追加:
  /** 前回訪問を上書きする前に呼ぶこと。未訪問は null */
  getVisit(userId: string, pageId: string): Promise<Visit | null>;
  recordVisit(userId: string, pageId: string, visitedAt: number, lastSeenVersion: number): Promise<void>;
```

- [ ] **Step 1: 失敗するテストを書く**

`test/storage/page-visits.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStorage } from '../helpers/storage.ts';
import { seedPage } from '../helpers/pages.ts';

const now = 1700000000;

test('getVisit: 未訪問は null', async () => {
  const { storage } = makeStorage();
  const project = await storage.ensureProject('proj', now);
  const pageId = await seedPage(storage, project.id, 'A', ['x'], now);
  assert.equal(await storage.getVisit('u1', pageId), null);
});

test('recordVisit → getVisit: upsert で最新値を返す', async () => {
  const { storage } = makeStorage();
  const project = await storage.ensureProject('proj', now);
  const pageId = await seedPage(storage, project.id, 'A', ['x'], now);
  await storage.recordVisit('u1', pageId, now, 1);
  assert.deepEqual(await storage.getVisit('u1', pageId), { visited: now, lastSeenVersion: 1 });
  await storage.recordVisit('u1', pageId, now + 10, 3);
  assert.deepEqual(await storage.getVisit('u1', pageId), { visited: now + 10, lastSeenVersion: 3 });
});

test('recordVisit: ユーザーごとに独立', async () => {
  const { storage } = makeStorage();
  const project = await storage.ensureProject('proj', now);
  const pageId = await seedPage(storage, project.id, 'A', ['x'], now);
  await storage.recordVisit('u1', pageId, now, 2);
  assert.equal(await storage.getVisit('u2', pageId), null);
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `direnv exec . npm test`
Expected: FAIL（`storage.getVisit is not a function`）

- [ ] **Step 3: 実装する**

`src/storage/types.ts` に `Visit` 型と 2 メソッド宣言を `interface Storage` に追加。

`src/storage/sqlite.ts`（page 系メソッドの近くに追加。`import type { Visit } from './types.ts';` を型import群に足す）:
```ts
  async getVisit(userId: string, pageId: string): Promise<Visit | null> {
    const row = this.#db
      .prepare('SELECT visited, last_seen_version FROM page_visits WHERE user_id = ? AND page_id = ?')
      .get(userId, pageId) as { visited: number; last_seen_version: number } | undefined;
    return row ? { visited: row.visited, lastSeenVersion: row.last_seen_version } : null;
  }

  async recordVisit(userId: string, pageId: string, visitedAt: number, lastSeenVersion: number): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO page_visits (user_id, page_id, visited, last_seen_version) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id, page_id) DO UPDATE SET visited = excluded.visited, last_seen_version = excluded.last_seen_version`,
      )
      .run(userId, pageId, visitedAt, lastSeenVersion);
  }
```

- [ ] **Step 4: 型検査とテストを通す**

Run: `direnv exec . npm test && direnv exec . npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: commit**

```bash
git add src/storage/types.ts src/storage/sqlite.ts test/storage/page-visits.test.ts
git commit -m "$(cat <<'EOF'
feat(storage): page_visits の読み書き(recordVisit/getVisit)を追加

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: storage — `listPageSummaries` の pinnedFirst と `TitleEntry.image`

**Files:**
- Modify: `src/storage/types.ts`
- Modify: `src/storage/sqlite.ts`
- Modify: `src/server/routes/read.ts`（`search/titles` の JSON マッピングに `image` を追記するだけ。既存フィールドの削除・変更はしない）
- Test: `test/storage/pages-api.test.ts`（`pinnedFirst` の追記）、`test/storage/related.test.ts`（`listPageTitles` の `image` の追記）

**Interfaces:**
```ts
// src/storage/types.ts
export type ListPageSummariesOptions = { skip: number; limit: number; sort: PageSort; pinnedFirst?: boolean };
export type TitleEntry = { id: string; title: string; hasIcon: boolean; updated: number; links: string[]; image: string | null };
// interface Storage に追加:
  setPinned(pageId: string, pinned: boolean): Promise<void>;
```

- [ ] **Step 1: 失敗するテストを書く**

`test/storage/pages-api.test.ts` に追記:
```ts
test('pinnedFirst: ピン留めページが sort に関わらず先頭に来る', async () => {
  const { storage } = makeStorage();
  const now = 1700000000;
  const project = await storage.ensureProject('proj', now);
  await seedPage(storage, project.id, 'Old Pinned', ['x'], now);
  await seedPage(storage, project.id, 'New Unpinned', ['x'], now + 10);
  const pinnedId = (await storage.getPageByTitle(project.id, 'old_pinned'))!.id;
  await storage.setPinned(pinnedId, true);
  const { pages } = await storage.listPageSummaries(project.id, { skip: 0, limit: 10, sort: 'updated', pinnedFirst: true });
  assert.equal(pages[0]!.title, 'Old Pinned');
  assert.equal(pages[1]!.title, 'New Unpinned');
});
```

`test/storage/related.test.ts` に追記:
```ts
test('listPageTitles: image は pages.image をそのまま返す', async () => {
  const { storage } = makeStorage();
  const now = 1700000000;
  const project = await storage.ensureProject('proj', now);
  await seedPage(storage, project.id, 'With Image', ['https://i.gyazo.com/x.png'], now);
  const titles = await storage.listPageTitles(project.id);
  assert.equal(titles.find((t) => t.title === 'With Image')!.image, 'https://i.gyazo.com/x.png');
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `direnv exec . npm test`
Expected: FAIL（`storage.setPinned is not a function`）

- [ ] **Step 3: 実装する**

`src/storage/sqlite.ts` の `listPageSummaries`（329行目付近）の `ORDER BY` 節を、`opts.pinnedFirst` が true のときだけ `p.pinned DESC, ` を先頭に付加するよう分岐する。既存の `sort` 別 `ORDER BY` マッピングはそのまま維持し、prefix するだけに留める（JSON API の `sort` パラメータの意味は変えない）。

`listPageTitles`（450行目付近）の SELECT に `p.image` を追加し、返り値オブジェクトに `image: row.image` を足す。

`setPinned` を新規追加する（page 系メソッドの近く）:
```ts
  async setPinned(pageId: string, pinned: boolean): Promise<void> {
    this.#db.prepare('UPDATE pages SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, pageId);
  }
```

`src/server/routes/read.ts` の `search/titles` ハンドラ（`storage.listPageTitles` の結果をそのまま JSON にしている箇所）に変更は不要な場合が多い（オブジェクトをそのまま返しているなら `image` は自動的に含まれる）。もし個別フィールドを列挙してマッピングしていたら `image: t.image` を追記する。

- [ ] **Step 4: テストを通す**

Run: `direnv exec . npm test && direnv exec . npx tsc --noEmit`

- [ ] **Step 5: commit**

---

### Task 3: `src/render/render.ts` — AST→HTML ラインレンダラ（テキスト・リンク・装飾）

`@progfay/scrapbox-parser` の `Block[]`（`codeBlock`/`table` が複数物理行を消費する）を、`src/core/links.ts` の `rewritePageLinks` と同じカーソル追跡パターンで `lines[]` と 1:1 整列した `RenderedLine[]` に変換する。メディア・アイコン埋め込みは Task 4 に分離する。

**Files:**
- Create: `src/render/render.ts`
- Test: `test/render/render.test.ts`

**Interfaces:**
```ts
// src/render/render.ts
import type { HtmlEscapedString } from 'hono/utils/html';

export type KnownPage = { title: string; image: string | null };
export type RenderConfig = { allowedFrameHosts: string[] };
export type RenderedLine = { lineId: string; html: HtmlEscapedString | Promise<HtmlEscapedString> };

/** knownPages: title_lc -> {title, image}。既存ページか判定（赤リンク）し、アイコン埋め込み用の image も引ける */
export function renderLines(
  lines: { id: string; text: string }[],
  knownPages: Map<string, KnownPage>,
  projectName: string,
  config: RenderConfig,
): RenderedLine[];
```

`lines` はページ本文全体（タイトル行込み）。`parse(..., { hasTitle: true })` により先頭ブロックは `type: 'title'` として 1 物理行を消費するので、`result[0]` は空文字列（`raw('')`）にする — タイトルは呼び出し側の view が `<h1>` で別途描画する。

- [ ] **Step 1: 失敗するテストを書く**

`test/render/render.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderLines } from '../../src/render/render.ts';

const cfg = { allowedFrameHosts: [] };

function renderOne(text: string, known: [string, string][] = []): string {
  const lines = [{ id: 'title', text: 'Title' }, { id: 'l1', text }];
  const map = new Map(known.map(([lc, title]) => [lc, { title, image: null }]));
  const out = renderLines(lines, map, 'proj', cfg);
  return String(out[1]!.html);
}

test('プレーンテキストはエスケープされる', () => {
  assert.equal(renderOne('<script>alert(1)</script>'), '<div>&lt;script&gt;alert(1)&lt;/script&gt;</div>');
});

test('ブラケットリンク: 既存ページは通常リンク、存在しないページは赤リンク', () => {
  const html = renderOne('[Foo]', [['foo', 'Foo']]);
  assert.match(html, /<a href="\/proj\/Foo"[^>]*>Foo<\/a>/);
  const red = renderOne('[Bar]');
  assert.match(red, /class="red-link"/);
  assert.match(red, /href="\/proj\/Bar\/edit"/);
});

test('ハッシュタグは title_lc で解決しブラケットリンクと同じ扱い', () => {
  assert.match(renderOne('#Foo', [['foo', 'Foo']]), /<a href="\/proj\/Foo"/);
});

test('外部リンクは http/https のみリンク化、他スキームは平文', () => {
  assert.match(renderOne('[https://example.com Ex]'), /<a href="https:\/\/example\.com"[^>]*>Ex<\/a>/);
  const js = renderOne('[javascript:alert(1) Ex]');
  assert.doesNotMatch(js, /<a /);
  assert.match(js, /javascript:alert\(1\)/);
});

test('太字の装飾', () => {
  assert.match(renderOne('[* bold]'), /<strong>bold<\/strong>/);
});

test('斜体・打ち消し線の装飾', () => {
  assert.match(renderOne('[/ italic]'), /<em>italic<\/em>/);
  assert.match(renderOne('[- strike]'), /<del>strike<\/del>/);
});

test('インラインコードはエスケープされたまま code タグに', () => {
  assert.match(renderOne('`<b>x</b>`'), /<code>&lt;b&gt;x&lt;\/b&gt;<\/code>/);
});

test('数式は out of scope につき code として描画', () => {
  assert.match(renderOne('[$ x^2]'), /<code>/);
});

test('画像リンクの alt にイベントハンドラを注入しようとしても属性値としてエスケープされる', () => {
  const html = renderOne('[" onerror="alert(1) https://example.com/a.png]');
  assert.doesNotMatch(html, /onerror=/);
});

test('コードブロックは複数物理行を 1 ブロックとして消費し、各物理行に対応する html を生成する', () => {
  const lines = [
    { id: 'title', text: 'Title' },
    { id: 'l1', text: 'code:a.js' },
    { id: 'l2', text: ' const x = 1;' },
    { id: 'l3', text: ' <script>x</script>' },
    { id: 'l4', text: 'after' },
  ];
  const out = renderLines(lines, new Map(), 'proj', cfg);
  assert.equal(out.length, 5);
  assert.match(String(out[3]!.html), /&lt;script&gt;/);
  assert.deepEqual(out.map((o) => o.lineId), ['title', 'l1', 'l2', 'l3', 'l4']);
});

test('テーブルも複数物理行を 1 ブロックとして消費する', () => {
  const lines = [
    { id: 'title', text: 'Title' },
    { id: 'l1', text: 'table:t' },
    { id: 'l2', text: ' a\tb' },
    { id: 'l3', text: ' c\td' },
  ];
  const out = renderLines(lines, new Map(), 'proj', cfg);
  assert.equal(out.length, 4);
  assert.match(String(out[2]!.html), /<table>/);
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `direnv exec . npm test`
Expected: FAIL（`src/render/render.ts` が存在しない）

- [ ] **Step 3: 実装する**

`src/render/render.ts`:
```ts
import { parse, type Node, type Block } from '@progfay/scrapbox-parser';
import { html, raw, type HtmlEscapedString } from 'hono/html';
import { titleLc, encodeTitleForUrl } from '../core/title.ts';

export type KnownPage = { title: string; image: string | null };
export type RenderConfig = { allowedFrameHosts: string[] };
export type RenderedLine = { lineId: string; html: HtmlEscapedString | Promise<HtmlEscapedString> };

function isHttpUrl(href: string): boolean {
  try {
    const u = new URL(href);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function pageHref(projectName: string, title: string): string {
  return `/${encodeURIComponent(projectName)}/${encodeTitleForUrl(title)}`;
}

function decorationTag(decos: string[]): string {
  if (decos.includes('*')) return 'strong';
  if (decos.includes('/')) return 'em';
  if (decos.includes('-')) return 'del';
  return 'span';
}

function makeRenderer(knownPages: Map<string, KnownPage>, projectName: string) {
  const renderNode = (node: Node): HtmlEscapedString | Promise<HtmlEscapedString> => {
    switch (node.type) {
      case 'plain':
      case 'blank':
        return html`${node.text}`;
      case 'code':
        return html`<code>${node.text}</code>`;
      case 'formula':
        return html`<code>${node.formula}</code>`;
      case 'helpfeel':
        return html`${node.text}`;
      case 'strong':
        return html`<strong>${node.nodes.map(renderNode)}</strong>`;
      case 'quote':
        return html`<blockquote>${node.nodes.map(renderNode)}</blockquote>`;
      case 'decoration': {
        const tag = decorationTag(node.decos as string[]);
        return html`<${raw(tag)}>${node.nodes.map(renderNode)}</${raw(tag)}>`;
      }
      case 'numberList':
        return html`<span class="num-list">${node.rawNumber}. ${node.nodes.map(renderNode)}</span>`;
      case 'commandLine':
        return html`<code>${node.symbol}${node.text}</code>`;
      case 'hashTag': {
        const entry = knownPages.get(titleLc(node.href));
        const href = entry ? pageHref(projectName, entry.title) : `${pageHref(projectName, node.href)}/edit`;
        return html`<a href="${href}" class="${entry ? '' : 'red-link'}">#${node.href}</a>`;
      }
      case 'icon':
      case 'strongIcon': {
        if (node.pathType !== 'relative') return html`<span class="icon-link">[${node.path}]</span>`;
        const entry = knownPages.get(titleLc(node.path));
        const href = pageHref(projectName, entry ? entry.title : node.path);
        return entry?.image
          ? html`<a href="${href}" class="icon-link"><img src="${entry.image}" alt="${node.path}" class="icon-img"></a>`
          : html`<a href="${href}" class="icon-link ${entry ? '' : 'red-link'}">[${node.path}]</a>`;
      }
      case 'image':
      case 'strongImage':
        return renderMedia(node.src, undefined);
      case 'googleMap':
        return html`${node.raw}`;
      case 'link': {
        if (node.pathType === 'relative') {
          const target = node.href.split('#')[0]!;
          const entry = knownPages.get(titleLc(target));
          const label = node.content !== '' ? node.content : target;
          const href = entry ? pageHref(projectName, entry.title) : `${pageHref(projectName, target)}/edit`;
          return html`<a href="${href}" class="${entry ? '' : 'red-link'}">${label}</a>`;
        }
        if (isHttpUrl(node.href)) {
          return renderMedia(node.href, node.content !== '' ? node.content : node.href);
        }
        return html`${node.content !== '' ? `${node.content} (${node.href})` : node.href}`;
      }
      default:
        return html`${node.raw}`;
    }
  };

  const renderMedia = (url: string, label: string | undefined): HtmlEscapedString | Promise<HtmlEscapedString> => {
    if (!isHttpUrl(url)) return label !== undefined ? html`${label} (${url})` : html`${url}`;
    switch (classifyUrl(url)) {
      case 'image':
        return html`<img src="${url}" alt="" loading="lazy">`;
      case 'video':
        return html`<video controls><source src="${url}"></video>`;
      case 'audio':
        return html`<audio controls><source src="${url}"></audio>`;
      default:
        return label !== undefined
          ? html`<a href="${url}" rel="noopener noreferrer">${label}</a>`
          : html`<a href="${url}" rel="noopener noreferrer">${url}</a>`;
    }
  };

  const renderTableCell = (nodes: Node[]): HtmlEscapedString | Promise<HtmlEscapedString> =>
    html`<td>${nodes.map(renderNode)}</td>`;

  return { renderNode, renderTableCell };
}

export function renderLines(
  lines: { id: string; text: string }[],
  knownPages: Map<string, KnownPage>,
  projectName: string,
  _config: RenderConfig,
): RenderedLine[] {
  const { renderNode, renderTableCell } = makeRenderer(knownPages, projectName);
  const result: RenderedLine[] = lines.map((l) => ({ lineId: l.id, html: raw('') }));
  const blocks = parse(lines.map((l) => l.text).join('\n'), { hasTitle: true }) as Block[];
  let index = 0;
  for (const block of blocks) {
    if (block.type === 'title') {
      index += 1;
    } else if (block.type === 'line') {
      result[index] = { lineId: lines[index]!.id, html: html`<div>${block.nodes.map(renderNode)}</div>` };
      index += 1;
    } else if (block.type === 'codeBlock') {
      const contentLines = block.content === '' ? [] : block.content.split('\n');
      result[index] = { lineId: lines[index]!.id, html: html`<div class="code-header">${block.fileName}</div>` };
      contentLines.forEach((c, i) => {
        result[index + 1 + i] = { lineId: lines[index + 1 + i]!.id, html: html`<div class="code-line">${c}</div>` };
      });
      index += 1 + contentLines.length;
    } else if (block.type === 'table') {
      result[index] = { lineId: lines[index]!.id, html: html`<div class="table-header">${block.fileName}</div>` };
      block.cells.forEach((row, r) => {
        result[index + 1 + r] = {
          lineId: lines[index + 1 + r]!.id,
          html: html`<div class="table-row"><table><tr>${row.map(renderTableCell)}</tr></table></div>`,
        };
      });
      index += 1 + block.cells.length;
    }
  }
  return result;
}
```

`import { classifyUrl } from '../core/media.ts';` を先頭に追加すること（上の `renderMedia` が参照）。

- [ ] **Step 4: テストを通す**

Run: `direnv exec . npm test && direnv exec . npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: commit**

---

### Task 4: メディア埋め込みのゴールデンテスト拡充（画像/動画/音声/YouTube/非httpスキーム）

Task 3 の `renderMedia` は実装済みなので、ここでは網羅テストのみ追加して固定する。

**Files:**
- Modify: `test/render/render.test.ts`（追記のみ）

- [ ] **Step 1: 失敗するテストを追記する**

```ts
test('画像URL(拡張子) は img、Gyazoホストも img', () => {
  assert.match(renderOne('https://i.gyazo.com/abc.png'), /<img src="https:\/\/i\.gyazo\.com\/abc\.png"/);
  assert.match(renderOne('https://example.com/a.png'), /<img src=/);
});

test('動画URLは video controls、音声は audio controls', () => {
  assert.match(renderOne('https://example.com/a.mp4'), /<video controls><source src="https:\/\/example\.com\/a\.mp4">/);
  assert.match(renderOne('https://example.com/a.mp3'), /<audio controls><source src="https:\/\/example\.com\/a\.mp3">/);
});

test('YouTube等は既定で埋め込まず通常リンク（iframe は生成しない）', () => {
  const out = renderOne('https://www.youtube.com/watch?v=abc');
  assert.doesNotMatch(out, /<iframe/);
  assert.match(out, /<a href="https:\/\/www\.youtube\.com\/watch\?v=abc"/);
});

test('非http(s)スキームのメディアURLはリンク化せず平文', () => {
  const out = renderOne('file:///etc/passwd.png');
  assert.doesNotMatch(out, /<img|<a /);
});

test('[Name.icon] は対象ページの image を img で表示、無ければブラケットテキスト', () => {
  const withImage = renderOne('[Foo.icon]', [['foo', 'Foo']]); // known だが image は null（renderOne のヘルパは image を渡せないため簡易化）
  assert.match(withImage, /icon-link/);
});
```

- [ ] **Step 2: 失敗を確認し、Task 3 の実装で通ることを確認する**

Run: `direnv exec . npm test`
Expected: PASS（Task 3 の実装が正しければ新規テストのみ追加で通るはず。通らない場合は Task 3 の `renderMedia`/icon 分岐を修正する）

- [ ] **Step 3: commit**

---

### Task 5: `src/server/app.ts` — HTML ルート向け認証ミドルウェアの変更

**Files:**
- Modify: `src/server/app.ts`
- Test: `test/server/auth-html.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`test/server/auth-html.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeServer } from '../helpers/server.ts';

test('未ログインで GET /:project は /login へ 302 リダイレクト', async () => {
  const s = await makeServer();
  await s.storage.ensureProject('proj', s.clock.t);
  const res = await s.request('/proj');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/login');
});

test('未ログインで API は 401 JSON のまま', async () => {
  const s = await makeServer();
  const res = await s.request('/api/pages/proj');
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, 'unauthorized');
});

test('GET /login は未ログインでも 200', async () => {
  const s = await makeServer();
  const res = await s.request('/login');
  assert.equal(res.status, 200);
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `direnv exec . npm test`
Expected: FAIL（現状は全ルートが 401 JSON、`/login` の GET ハンドラも未実装）

- [ ] **Step 3: 実装する**

`src/server/app.ts` のセッションミドルウェア（`app.use('*', ...)`、現在 `/api/knot/session` の POST だけを除外している箇所）を置換:
```ts
  const PUBLIC_PATHS = new Set(['/login']);

  app.use('*', async (c, next) => {
    if (c.req.method === 'POST' && c.req.path === '/api/knot/session') return next();
    if (PUBLIC_PATHS.has(c.req.path) || c.req.path.startsWith('/assets/')) return next();
    const sid = getCookie(c, SESSION_COOKIE);
    const session = sid === undefined ? null : await storage.getSession(sid, now());
    if (session === null) {
      const isApiOrFiles = c.req.path.startsWith('/api/') || c.req.path.startsWith('/files/');
      if (isApiOrFiles) return jsonError(c, 401, 'unauthorized');
      return c.redirect('/login', 302);
    }
    if (session.expires - now() < config.sessionTtlSeconds - REFRESH_MARGIN_SECONDS) {
      await storage.refreshSession(session.id, now() + config.sessionTtlSeconds);
      setSessionCookie(c, session.id);
    }
    c.set('userId', session.userId);
    return next();
  });
```

`registerReadRoutes`/`registerWriteRoutes`/`registerFileRoutes` の呼び出しの後に、一時的なプレースホルダを追加してこのタスクのテストだけを通す（Task 7 で `routes/pages.ts` に切り出す。plan-03 Task 6→7 と同じ「仮ルート→本実装」の手順）:
```ts
  app.get('/login', (c) => c.text('login placeholder'));
```

- [ ] **Step 4: テストを通す**

Run: `direnv exec . npm test && direnv exec . npx tsc --noEmit`

- [ ] **Step 5: commit**

---

### Task 6: 静的アセット配信 (`/assets/*`) と `public/app.css`

**Files:**
- Create: `public/app.css`
- Modify: `src/server/app.ts`
- Test: `test/server/assets.test.ts`

**Interfaces:**
- Consumes: `serveStatic` from `@hono/node-server/serve-static`

- [ ] **Step 1: 失敗するテスト**

`test/server/assets.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeServer } from '../helpers/server.ts';

test('GET /assets/app.css は認証なしで text/css を返す', async () => {
  const s = await makeServer();
  const res = await s.request('/assets/app.css');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/css/);
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `direnv exec . npm test`

- [ ] **Step 3: 実装する**

`public/app.css`:
```css
body { font-family: system-ui, sans-serif; margin: 0; padding: 1rem; }
a { color: #2c6ea3; }
.red-link { color: #c0392b; }
.card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 1rem; list-style: none; padding: 0; }
.card { display: block; border: 1px solid #ddd; border-radius: 4px; padding: 0.5rem; text-decoration: none; color: inherit; }
.card.pinned { border-color: #f1c40f; }
.card img.card-image { max-width: 100%; height: 100px; object-fit: cover; }
.line-row { display: flex; align-items: flex-start; }
.telomere { width: 4px; align-self: stretch; margin-right: 0.5rem; flex-shrink: 0; background: #ccc; cursor: pointer; }
.telomere.unread { background: #3498db; }
.telomere.age-1 { opacity: 1; }
.telomere.age-2 { opacity: 0.6; }
.telomere.age-3 { opacity: 0.3; }
.line-row.highlight { background: #fff8dc; }
.code-line { font-family: monospace; white-space: pre; }
.icon-img { height: 1.2em; vertical-align: middle; }
.error { color: #c0392b; }
```

`src/server/app.ts`:
```ts
import { serveStatic } from '@hono/node-server/serve-static';
// ...
  app.use('/assets/*', serveStatic({ root: './public', rewriteRequestPath: (p) => p.replace(/^\/assets/, '') }));
```
このミドルウェアは、Task 5 で `/assets/` を素通りさせるセッション認証ミドルウェアより後ろでも問題ない（同じ理由でどちらも通す）が、コードの流れとしてはセキュリティヘッダ・認証ミドルウェアの直後、`registerReadRoutes` 等より前に置く。

- [ ] **Step 4: テスト**

Run: `direnv exec . npm test && direnv exec . npx tsc --noEmit`

- [ ] **Step 5: commit**

---

### Task 7: 共有レイアウトとログイン画面

**Files:**
- Create: `src/server/views/layout.ts`
- Create: `src/server/views/login.ts`
- Create: `src/server/routes/pages.ts`
- Create: `public/login.js`
- Modify: `src/server/app.ts`（`registerPageRoutes` 呼び出しに切り替え、Task 5 のプレースホルダを削除）
- Test: `test/server/login-page.test.ts`

**Interfaces:**
```ts
// src/server/views/layout.ts
export function layout(title: string, body: HtmlEscapedString | Promise<HtmlEscapedString>): HtmlEscapedString;

// src/server/views/login.ts
export function loginPage(): HtmlEscapedString;

// src/server/routes/pages.ts
export function registerPageRoutes(app: Hono<ApiEnv>, deps: AppDeps): void;
```

- [ ] **Step 1: 失敗するテスト**

`test/server/login-page.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeServer } from '../helpers/server.ts';

test('GET /login は外部 css/js のみを参照し、インライン script/style を含まない', async () => {
  const s = await makeServer();
  const res = await s.request('/login');
  const body = await res.text();
  assert.match(body, /<link rel="stylesheet" href="\/assets\/app\.css">/);
  assert.match(body, /<script src="\/assets\/login\.js"/);
  assert.doesNotMatch(body, /<script>/);
  assert.doesNotMatch(body, /<style>/);
  assert.doesNotMatch(body, / on[a-z]+="/);
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `direnv exec . npm test`

- [ ] **Step 3: 実装する**

`src/server/views/layout.ts`:
```ts
import { html, type HtmlEscapedString } from 'hono/html';

export function layout(title: string, body: HtmlEscapedString | Promise<HtmlEscapedString>): HtmlEscapedString {
  return html`<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="/assets/app.css">
</head>
<body>${body}</body>
</html>` as unknown as HtmlEscapedString;
}
```

`src/server/views/login.ts`:
```ts
import { html, type HtmlEscapedString } from 'hono/html';
import { layout } from './layout.ts';

export function loginPage(): HtmlEscapedString {
  return layout('ログイン', html`
<form id="login-form">
  <label>ユーザー名 <input type="text" name="name" required></label>
  <label>パスワード <input type="password" name="password" required></label>
  <button type="submit">ログイン</button>
</form>
<script src="/assets/login.js" defer></script>`) as unknown as HtmlEscapedString;
}
```

`public/login.js`:
```js
document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  const res = await fetch('/api/knot/session', {
    method: 'POST',
    headers: { 'X-Knot-Client': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: form.get('name'), password: form.get('password') }),
  });
  if (res.ok) {
    const params = new URLSearchParams(location.search);
    location.href = params.get('next') ?? '/';
    return;
  }
  const msg = res.status === 429 ? '試行回数が多すぎます。しばらく待ってください。' : 'ユーザー名またはパスワードが違います。';
  let p = document.querySelector('.error');
  if (!p) {
    p = document.createElement('p');
    p.className = 'error';
    e.target.appendChild(p);
  }
  p.textContent = msg;
});
```

`src/server/routes/pages.ts`:
```ts
import type { Hono } from 'hono';
import type { AppDeps } from '../app.ts';
import type { ApiEnv } from '../http.ts';
import { loginPage } from '../views/login.ts';

export function registerPageRoutes(app: Hono<ApiEnv>, _deps: AppDeps): void {
  app.get('/login', (c) => c.html(loginPage()));
}
```

`src/server/app.ts`: `import { registerPageRoutes } from './routes/pages.ts';` を追加し、`registerFileRoutes(app, deps);` の後に `registerPageRoutes(app, deps);` を追加。Task 5 で足した `app.get('/login', (c) => c.text('login placeholder'));` を削除する。

- [ ] **Step 4: テストを通す**

Run: `direnv exec . npm test && direnv exec . npx tsc --noEmit`

- [ ] **Step 5: commit**

---

### Task 8: ページ一覧 `GET /:project`

**Files:**
- Modify: `src/server/routes/pages.ts`
- Create: `src/server/views/pageList.ts`
- Test: `test/server/pages-list.test.ts`

**Interfaces:**
```ts
// src/server/views/pageList.ts
export function pageListPage(
  project: Project,
  result: { count: number; pages: PageSummary[] },
  skip: number,
  limit: number,
): HtmlEscapedString;
```

- [ ] **Step 1: 失敗するテストを書く**

`test/server/pages-list.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeServer } from '../helpers/server.ts';
import { seedPage } from '../helpers/pages.ts';

async function login(s: Awaited<ReturnType<typeof makeServer>>): Promise<string> {
  await s.addUser('alice', 'pw12345678');
  return s.login('alice', 'pw12345678');
}

test('GET /:project: ピン留めが先頭、以降は更新順、カードにタイトル・冒頭行が出る', async () => {
  const s = await makeServer();
  const cookie = await login(s);
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'Old', ['first line'], s.clock.t);
  await seedPage(s.storage, project.id, 'New', ['other line'], s.clock.t + 10);
  const oldPage = await s.storage.getPageByTitle(project.id, 'old');
  await s.storage.setPinned(oldPage!.id, true);
  const res = await s.request('/proj', {}, cookie);
  assert.equal(res.status, 200);
  const body = await res.text();
  const oldIndex = body.indexOf('Old');
  const newIndex = body.indexOf('New');
  assert.ok(oldIndex >= 0 && newIndex > oldIndex);
  assert.match(body, /first line/);
});

test('もっと見るリンク: count が limit を超えたら次ページへのリンクが出る', async () => {
  const s = await makeServer();
  const cookie = await login(s);
  const project = await s.storage.ensureProject('proj', s.clock.t);
  for (let i = 0; i < 3; i += 1) await seedPage(s.storage, project.id, `Page ${i}`, ['x'], s.clock.t + i);
  const res = await s.request('/proj?limit=2', {}, cookie);
  const body = await res.text();
  assert.match(body, /href="\/proj\?skip=2&limit=2"/);
});

test('未ログインは /login へリダイレクト', async () => {
  const s = await makeServer();
  await s.storage.ensureProject('proj', s.clock.t);
  const res = await s.request('/proj');
  assert.equal(res.status, 302);
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `direnv exec . npm test`

- [ ] **Step 3: 実装する**

`src/server/views/pageList.ts`:
```ts
import { html, type HtmlEscapedString } from 'hono/html';
import type { PageSummary, Project } from '../../storage/types.ts';
import { encodeTitleForUrl } from '../../core/title.ts';
import { layout } from './layout.ts';

function card(project: Project, page: PageSummary): HtmlEscapedString {
  const href = `/${encodeURIComponent(project.name)}/${encodeTitleForUrl(page.title)}`;
  return html`<a class="card ${page.pinned ? 'pinned' : ''}" href="${href}">
  ${page.image ? html`<img class="card-image" src="${page.image}" alt="">` : ''}
  <h3>${page.title}</h3>
  ${page.descriptions.map((d) => html`<p>${d}</p>`)}
</a>` as unknown as HtmlEscapedString;
}

export function pageListPage(
  project: Project,
  result: { count: number; pages: PageSummary[] },
  skip: number,
  limit: number,
): HtmlEscapedString {
  const nextSkip = skip + limit;
  const hasMore = nextSkip < result.count;
  return layout(project.displayName, html`
<h1>${project.displayName}</h1>
<input id="search-box" type="search" placeholder="検索">
<div id="search-results" hidden></div>
<div class="card-grid">${result.pages.map((p) => card(project, p))}</div>
${hasMore ? html`<a href="/${encodeURIComponent(project.name)}?skip=${nextSkip}&limit=${limit}">もっと見る</a>` : ''}
<script src="/assets/search.js" defer data-project="${project.name}"></script>`);
}
```

`src/server/routes/pages.ts` に追加（`resolveProject`/`jsonError` は `../http.ts` から import）:
```ts
  app.get('/:project', async (c) => {
    const project = await deps.storage.getProject(c.req.param('project'));
    if (!project) return c.notFound();
    const skip = Number(c.req.query('skip') ?? '0');
    const limit = Number(c.req.query('limit') ?? '30');
    if (!Number.isInteger(skip) || skip < 0 || !Number.isInteger(limit) || limit <= 0 || limit > 200) {
      return c.text('bad request', 400);
    }
    const result = await deps.storage.listPageSummaries(project.id, { skip, limit, sort: 'updated', pinnedFirst: true });
    return c.html(pageListPage(project, result, skip, limit));
  });
```
`registerPageRoutes` のシグネチャを `(app: Hono<ApiEnv>, deps: AppDeps): void` に変え（Task 7 で `_deps` にしていたのを `deps` に戻す）、`app.get('/login', ...)` より後にこのルートを登録する。

- [ ] **Step 4: テストを通す**

Run: `direnv exec . npm test && direnv exec . npx tsc --noEmit`

- [ ] **Step 5: commit**

---

### Task 9: ページ閲覧 `GET /:project/:title`（レンダラ・テロメア・関連ページ・404）

**Files:**
- Modify: `src/server/routes/pages.ts`
- Create: `src/server/views/pageView.ts`
- Create: `public/line-ui.js`
- Test: `test/server/pages-view.test.ts`

**Interfaces:**
```ts
// src/server/views/pageView.ts
export function pageViewPage(
  project: Project,
  page: PageSnapshot,
  rendered: RenderedLine[],
  previousVisit: Visit | null,
  related: RelatedPages,
): HtmlEscapedString;
export function pageNotFoundPage(project: Project, title: string): HtmlEscapedString;
```

**設計メモ（実装者向け、そのまま反映すること）:**
- `getVisit`（前回訪問）は `recordVisit`（今回訪問の記録）より**前**に呼ぶ。順序を誤ると全行が既読判定になってしまう。
- 未読判定: `previousVisit === null || line.updatedVersion > previousVisit.lastSeenVersion`。
- 経過表示（バーの太さ）は `page.updated - line.updated`（秒）を 3 段階（1日未満 `age-1`、7日未満 `age-2`、それ以上 `age-3`）にバケット化する定数 `TELOMERE_AGE_BUCKETS = [86400, 7 * 86400]` を `pageView.ts` に置く。
- 関連ページは `related.links1hop`（前方リンク先∪逆リンク元の合併、storage の既存仕様どおり）と `related.links2hop` をそのまま 2 つのセクションとして表示する。1-hop と逆リンクを視覚的に分離しない（storage 側のデータ形状がマージ済みのため、v1 はこの粒度を受け入れる）。`related.hasBackLinks` は「逆リンクまたはアイコン参照あり」のバッジ表示に使う。

- [ ] **Step 1: 失敗するテストを書く**

`test/server/pages-view.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeServer } from '../helpers/server.ts';
import { seedPage } from '../helpers/pages.ts';

async function login(s: Awaited<ReturnType<typeof makeServer>>): Promise<string> {
  await s.addUser('alice', 'pw12345678');
  return s.login('alice', 'pw12345678');
}

test('GET /:project/:title: レンダリング結果・赤リンク・テロメア・関連ページを含む', async () => {
  const s = await makeServer();
  const cookie = await login(s);
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'Beta', ['x'], s.clock.t);
  const alphaId = await seedPage(s.storage, project.id, 'Alpha', ['see [Beta] and [Ghost]'], s.clock.t + 1);
  const res = await s.request('/proj/Alpha', {}, cookie);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /class="red-link"[^>]*>Ghost</);
  assert.match(body, /href="\/proj\/Beta"[^>]*>Beta</);
  assert.match(body, /class="telomere/);
  assert.match(body, /Beta/); // 関連ページセクションに 1-hop として出る
  void alphaId;
});

test('初回訪問は全行 unread、再訪問（編集なし）は unread が消える', async () => {
  const s = await makeServer();
  const cookie = await login(s);
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'Alpha', ['line one'], s.clock.t);
  const first = await s.request('/proj/Alpha', {}, cookie);
  assert.match(await first.text(), /telomere unread/);
  const second = await s.request('/proj/Alpha', {}, cookie);
  assert.doesNotMatch(await second.text(), /telomere unread/);
});

test('存在しないページは 404 と新規作成の案内', async () => {
  const s = await makeServer();
  const cookie = await login(s);
  await s.storage.ensureProject('proj', s.clock.t);
  const res = await s.request('/proj/Nope', {}, cookie);
  assert.equal(res.status, 404);
  assert.match(await res.text(), /Nope/);
  assert.match(await res.text(), /\/proj\/Nope\/edit/);
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `direnv exec . npm test`

- [ ] **Step 3: 実装する**

`src/server/routes/pages.ts` に追加（`resolveProject`, `resolvePage`, `safeDecode` を `../http.ts` から import、`renderLines` を `../../render/render.ts` から import、`titleLc` を `../../core/title.ts` から import）:
```ts
  app.get('/:project/:title', async (c) => {
    const project = await resolveProject(deps.storage, c);
    if (!project) return c.notFound();
    const page = await resolvePage(deps.storage, project.id, c);
    const now = deps.now?.() ?? Math.floor(Date.now() / 1000);
    if (!page) {
      const raw = safeDecode(c.req.param('title')) ?? c.req.param('title');
      c.status(404);
      return c.html(pageNotFoundPage(project, raw));
    }
    const userId = c.get('userId');
    const previousVisit = await deps.storage.getVisit(userId, page.id);
    const related = await deps.storage.getRelatedPages(project.id, page.id, page.titleLc);
    const titles = await deps.storage.listPageTitles(project.id);
    const knownPages = new Map(titles.map((t) => [titleLc(t.title), { title: t.title, image: t.image }]));
    const rendered = renderLines(page.lines, knownPages, project.name, { allowedFrameHosts: deps.config.allowedFrameHosts });
    await deps.storage.recordVisit(userId, page.id, now, page.version);
    return c.html(pageViewPage(project, page, rendered, previousVisit, related));
  });
```
このハンドラは `app.get('/:project', ...)` の後に登録する（`/:project/:title` は 2 セグメントなので `/:project` と衝突しないが、可読性のため一覧→詳細の順で並べる）。

`src/server/views/pageView.ts`:
```ts
import { html, type HtmlEscapedString } from 'hono/html';
import type { PageSnapshot, Project, RelatedPages, Visit } from '../../storage/types.ts';
import type { RenderedLine } from '../../render/render.ts';
import { encodeTitleForUrl } from '../../core/title.ts';
import { layout } from './layout.ts';

const TELOMERE_AGE_BUCKETS = [86400, 7 * 86400];

function ageClass(page: PageSnapshot, updated: number): string {
  const age = page.updated - updated;
  if (age < TELOMERE_AGE_BUCKETS[0]!) return 'age-1';
  if (age < TELOMERE_AGE_BUCKETS[1]!) return 'age-2';
  return 'age-3';
}

function lineRow(page: PageSnapshot, rendered: RenderedLine, previousVisit: Visit | null): HtmlEscapedString {
  const line = page.lines.find((l) => l.id === rendered.lineId)!;
  const unread = previousVisit === null || line.updatedVersion > previousVisit.lastSeenVersion;
  return html`<div class="line-row" id="L${line.id}">
  <span class="telomere ${ageClass(page, line.updated)} ${unread ? 'unread' : ''}" data-updated="${line.updated}" data-user="${line.userId}"></span>
  ${rendered.html}
</div>` as unknown as HtmlEscapedString;
}

function relatedSection(title: string, pages: { title: string }[], projectName: string): HtmlEscapedString {
  if (pages.length === 0) return html`` as unknown as HtmlEscapedString;
  return html`<section><h2>${title}</h2><ul>${pages.map(
    (p) => html`<li><a href="/${encodeURIComponent(projectName)}/${encodeTitleForUrl(p.title)}">${p.title}</a></li>`,
  )}</ul></section>` as unknown as HtmlEscapedString;
}

export function pageViewPage(
  project: Project,
  page: PageSnapshot,
  rendered: RenderedLine[],
  previousVisit: Visit | null,
  related: RelatedPages,
): HtmlEscapedString {
  return layout(page.title, html`
<h1>${page.title}</h1>
<div class="page-body">${rendered.map((r) => lineRow(page, r, previousVisit))}</div>
${relatedSection('関連ページ', related.links1hop, project.name)}
${relatedSection('2-hop リンク', related.links2hop, project.name)}
<script src="/assets/line-ui.js" defer></script>`);
}

export function pageNotFoundPage(project: Project, title: string): HtmlEscapedString {
  const editHref = `/${encodeURIComponent(project.name)}/${encodeTitleForUrl(title)}/edit`;
  return layout('ページが見つかりません', html`
<h1>「${title}」はまだありません</h1>
<a href="${editHref}">このタイトルで新規作成する</a>`);
}
```

`public/line-ui.js`:
```js
function highlight() {
  document.querySelectorAll('.line-row.highlight').forEach((el) => el.classList.remove('highlight'));
  const id = location.hash.slice(1);
  if (!id) return;
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add('highlight');
  el.scrollIntoView({ block: 'center' });
}
window.addEventListener('hashchange', highlight);
highlight();

const rtf = new Intl.RelativeTimeFormat('ja', { numeric: 'auto' });
function relativeTime(unixSeconds) {
  const diff = unixSeconds - Math.floor(Date.now() / 1000);
  const abs = Math.abs(diff);
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  return rtf.format(Math.round(diff / 86400), 'day');
}

document.querySelectorAll('.telomere').forEach((el) => {
  const updated = Number(el.dataset.updated);
  el.title = relativeTime(updated);
  el.addEventListener('click', () => {
    const exact = new Date(updated * 1000).toLocaleString('ja-JP');
    alert(`${exact} / ${el.dataset.user}`);
  });
});
```

- [ ] **Step 4: テストを通す**

Run: `direnv exec . npm test && direnv exec . npx tsc --noEmit`

- [ ] **Step 5: commit**

---

### Task 10: 検索 UI（タイトル部分一致 + 全文検索）

**Files:**
- Create: `public/search.js`
- Test: `test/server/pages-list.test.ts`（追記）

- [ ] **Step 1: 失敗するテストを追記する**

```ts
test('検索ボックスと script タグが一覧ページに含まれる', async () => {
  const s = await makeServer();
  const cookie = await login(s);
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'A', ['x'], s.clock.t);
  const res = await s.request('/proj', {}, cookie);
  const body = await res.text();
  assert.match(body, /id="search-box"/);
  assert.match(body, /<script src="\/assets\/search\.js"[^>]*data-project="proj"/);
  assert.doesNotMatch(body, /<script>/);
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `direnv exec . npm test`
Expected: FAIL（`public/search.js` の存在確認はテストできないが、Task 8 の view 出力に `search-box`/`data-project` が既にあるため、実は Step 1 は Task 8 完了時点で既に通っている可能性が高い — 通っていれば Step 3 のみ実施すればよい）

- [ ] **Step 3: 実装する**

`public/search.js`:
```js
const script = document.currentScript;
const project = script.dataset.project;
let titles = null;
let debounceTimer = null;

async function loadTitles() {
  if (titles !== null) return titles;
  const res = await fetch(`/api/pages/${encodeURIComponent(project)}/search/titles`);
  titles = await res.json();
  return titles;
}

function pageHref(title) {
  return `/${encodeURIComponent(project)}/${encodeURIComponent(title.replaceAll(' ', '_'))}`;
}

function renderHits(el, items, formatLabel) {
  el.replaceChildren();
  if (items.length === 0) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  for (const item of items) {
    const a = document.createElement('a');
    a.href = pageHref(item.title);
    a.className = 'search-hit';
    a.textContent = formatLabel(item);
    el.appendChild(a);
  }
}

document.getElementById('search-box').addEventListener('input', async (e) => {
  const q = e.target.value.trim();
  const resultsEl = document.getElementById('search-results');
  clearTimeout(debounceTimer);
  if (q === '') {
    renderHits(resultsEl, [], () => '');
    return;
  }
  const all = await loadTitles();
  const lc = q.toLowerCase();
  renderHits(resultsEl, all.filter((t) => t.title.toLowerCase().includes(lc)).slice(0, 20), (t) => t.title);

  debounceTimer = setTimeout(async () => {
    const res = await fetch(`/api/pages/${encodeURIComponent(project)}/search/query?q=${encodeURIComponent(q)}`);
    const body = await res.json();
    renderHits(resultsEl, body.pages, (p) => `${p.title}: ${p.lines[0] ?? ''}`);
  }, 200);
});
```

- [ ] **Step 4: テストを通す**

Run: `direnv exec . npm test && direnv exec . npx tsc --noEmit`

- [ ] **Step 5: commit**

---

### Task 11: E2E スモークテスト

**Files:**
- Create: `test/server/web-read-e2e.test.ts`

- [ ] **Step 1: テストを書く**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeServer } from '../helpers/server.ts';
import { seedPage } from '../helpers/pages.ts';

test('login → 一覧 → 閲覧 → 再訪問 → 404 の一気通貫、インライン script/style/onclick が一切ない', async () => {
  const s = await makeServer();
  await s.addUser('alice', 'pw12345678');
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'Beta', ['content'], s.clock.t);
  await seedPage(s.storage, project.id, 'Alpha', ['links to [Beta] and [Ghost]'], s.clock.t + 1);

  const unauth = await s.request('/proj');
  assert.equal(unauth.status, 302);

  const loginRes = await s.request('/login');
  assert.equal(loginRes.status, 200);

  const cookie = await s.login('alice', 'pw12345678');
  const bodies: string[] = [];

  const list1 = await s.request('/proj', {}, cookie);
  assert.equal(list1.status, 200);
  bodies.push(await list1.text());

  const view1 = await s.request('/proj/Alpha', {}, cookie);
  assert.equal(view1.status, 200);
  const view1Body = await view1.text();
  assert.match(view1Body, /telomere unread/);
  bodies.push(view1Body);

  const view2 = await s.request('/proj/Alpha', {}, cookie);
  const view2Body = await view2.text();
  assert.doesNotMatch(view2Body, /telomere unread/);
  bodies.push(view2Body);

  const notFound = await s.request('/proj/Nope', {}, cookie);
  assert.equal(notFound.status, 404);
  bodies.push(await notFound.text());

  for (const body of bodies) {
    assert.doesNotMatch(body, /<script>/);
    assert.doesNotMatch(body, /<style>/);
    assert.doesNotMatch(body, / on[a-z]+="/);
  }
});
```

- [ ] **Step 2: テストを実行し全体スイートが通ることを確認する**

Run: `direnv exec . npm test && direnv exec . npx tsc --noEmit`
Expected: PASS（全テスト、tsc clean）

- [ ] **Step 3: commit**

```bash
git add test/server/web-read-e2e.test.ts
git commit -m "$(cat <<'EOF'
test(server): plan-04 web-read の E2E スモークテストを追加

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## 検証（人間による最終確認）

1. `direnv exec . npm test && direnv exec . npx tsc --noEmit` が通ること。
2. `knot user add` でユーザーを作り、`knot serve --data ./data` を起動し、ブラウザで `http://localhost:<port>/login` → ログイン → `/:project` → ページ閲覧まで一通り目視確認する（カード表示、赤リンク、テロメアのホバー/クリック、行 permalink のハイライト、検索ボックスの絞り込み）。
3. ブラウザの開発者ツールで、レンダリングされたページに `<script>alert(1)</script>` 等を含む本文を保存済みのページ（`PUT .../text` API で直接投入可能）を開き、スクリプトが実行されないことを確認する。
4. CSP ヘッダ（`Content-Security-Policy: default-src 'self'; ...`）がすべてのページで返っていることを確認する。

## Self-Review メモ（作成時点）

- 仕様カバレッジ: 画面構成（login/一覧/閲覧）、メディア埋め込み、リンクとタグ（1-hop/2-hop/赤リンク）、テロメア（新旧・既読未読・permalink・ホバー詳細）、検索UI（簡易版、ユーザー承認済み）、レンダリングのXSS安全化、エラー処理（401リダイレクト/404作成案内）を Task 1-11 でカバーした。エディタ・rename UI・添付アップロードUI は plan-05 以降のためスコープ外。
- `setPinned` は現行コードベースにピン留め切替手段が一切ないことを確認したうえで Task 2 に新規メソッドとして追加した（未解決フラグではなく確定済みの設計）。

## Errata（実装後レビューによる追記、2026-07-16）

実装完了後のレビュー（8角度ファインダー + 検証）で、この計画自体に由来する欠陥が複数見つかった。
本節はその対応表と、計画の作り方への教訓を記録する。
実装は計画をほぼ忠実に反映していたため、以下の多くは「計画のコード断片のバグがそのまま本番コードに転写された」ものである。

### 計画由来のバグと修正コミット

| 欠陥 | 計画上の起源 | 修正コミット |
| --- | --- | --- |
| codeBlock の空白のみ本体行で以降全行の HTML/lineId がズレる | Task 3 スニペットの `block.content === '' ? [] : split('\n')`（内容0行と空白1行を区別できない） | `eabbdb7` |
| メディア埋め込みが CSP（img-src/media-src allowlist）と突き合わされておらず、既定設定では Gyazo 以外の画像と外部 video/audio が全部ブロックされる | Global Constraints に CSP を掲げつつ照合工程がなく、`RenderConfig.allowedFrameHosts` は定義のみで未使用の死んだ配線だった | `eabbdb7` |
| `serveStatic({ root: './public' })` が cwd 相対で、リポジトリ外から `knot serve` すると全アセット 404 | Task 6 スニペット | `39559f2` |
| ログイン後の既定遷移先 `/` にルートがなく plain-text 404 に着地 | Task 7 の `login.js` スニペット（`next ?? '/'`）+ どのタスクも `GET /` を定義していない | `39559f2` |
| 検索UIで古いクエリの遅い応答が新しい表示を上書きする（順序保証なし） | Task 10 の `search.js` スニペット | `b7ba6a6` |
| GET でのページ閲覧が無条件に `recordVisit` し、SameSite=Lax 下のクロスサイト遷移・プリフェッチでも既読化される | Task 9 の設計（決定: GET のまま `Sec-Fetch-Site: cross-site` / `Sec-Purpose: prefetch` をスキップするガードを追加） | `39559f2` |
| ページ閲覧ごとに `listPageTitles`（links の N+1 サブクエリ）を呼び links を捨てる | Task 9 スニペットが knownPages の構築に `listPageTitles` を指定 | `39559f2` |
| `lineRow` の O(行数²) `find`、views の `as unknown as HtmlEscapedString` 二重キャスト、URL 組み立ての5箇所コピペ | Task 7-9 の各スニペット | `e555613` |
| 並行するページ閲覧の完了順によって `page_visits` が古い版へ巻き戻る | Task 1 の upsert が既存値を無条件に上書きしていた | レビュー追補で `visited` と `last_seen_version` を単調増加に修正 |
| CSP 許可ホストとの照合が本文画像にしか適用されず、アイコン画像と一覧カード画像が壊れる | Task 2・Task 8 の画像表示と Task 3 の許可ホスト判定が分離していた | レビュー追補で共通の許可ホスト判定を全画像経路に適用 |

### 実装が計画から自力で救済していた点（記録）

- 計画の `login.js` は `next` を無検証で使うオープンリダイレクトだったが、実装がオリジン検証を追加した（`32d2806`, `d8e5c12`）。
- 計画の `decorationTag` は `decos.includes('*')` 判定で、scrapbox-parser の実際の deco 形式（`'*-1'` 等）では太字が効かないコードだったが、実装が `startsWith('*')` に修正していた。

### 既知の段階的状態

- 赤リンクと 404 ページの `/edit` リンクは plan-05 でエディタが入るまで 404 になる（意図的な段階分割）。

### 計画の作り方への教訓（plan-05 以降に適用）

- コード断片を「そのまま反映すること」と指示するのをやめ、インターフェース + 挙動 + テスト仕様の指定に留める。
- Global Constraints（CSP 等）と各機能の突き合わせチェックを計画の Self-Review に含める。
- 実行前に spec-ambiguity-audit を通す。
