import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderLines } from '../../src/render/render.ts';

const cfg = {
  allowedImageHosts: ['example.com', 'i.gyazo.com', 'gyazo.com'],
  allowedMediaHosts: ['example.com'],
};

function renderOne(text: string, known: [string, string][] = [], config = cfg): string {
  const lines = [{ id: 'title', text: 'Title' }, { id: 'l1', text }];
  const map = new Map(known.map(([lc, title]) => [lc, { title, image: null }]));
  const out = renderLines(lines, map, 'proj', config);
  return String(out[1]!.html);
}

void test('プレーンテキストはエスケープされる', () => {
  assert.equal(renderOne('<script>alert(1)</script>'), '<div>&lt;script&gt;alert(1)&lt;/script&gt;</div>');
});

void test('ブラケットリンク: 既存ページは通常リンク、存在しないページは赤リンク', () => {
  const html = renderOne('[Foo]', [['foo', 'Foo']]);
  assert.match(html, /<a href="\/proj\/Foo"[^>]*>Foo<\/a>/);
  const red = renderOne('[Bar]');
  assert.match(red, /class="red-link"/);
  assert.match(red, /href="\/proj\/Bar\/edit"/);
});

void test('ハッシュタグは title_lc で解決しブラケットリンクと同じ扱い', () => {
  assert.match(renderOne('#Foo', [['foo', 'Foo']]), /<a href="\/proj\/Foo"/);
});

void test('外部リンクは http/https のみリンク化、他スキームは平文', () => {
  assert.match(renderOne('[https://example.com Ex]'), /<a href="https:\/\/example\.com"[^>]*>Ex<\/a>/);
  const js = renderOne('[javascript:alert(1) Ex]');
  assert.doesNotMatch(js, /<a /);
  assert.match(js, /javascript:alert\(1\)/);
});

void test('太字の装飾', () => {
  assert.match(renderOne('[* bold]'), /<strong>bold<\/strong>/);
});

void test('斜体・打ち消し線の装飾', () => {
  assert.match(renderOne('[/ italic]'), /<em>italic<\/em>/);
  assert.match(renderOne('[- strike]'), /<del>strike<\/del>/);
});

void test('インラインコードはエスケープされたまま code タグに', () => {
  assert.match(renderOne('`<b>x</b>`'), /<code>&lt;b&gt;x&lt;\/b&gt;<\/code>/);
});

void test('数式は out of scope につき code として描画', () => {
  assert.match(renderOne('[$ x^2]'), /<code>/);
});

void test('画像リンクの alt にイベントハンドラを注入しようとしても属性値としてエスケープされる', () => {
  const html = renderOne('[" onerror="alert(1) https://example.com/a.png]');
  assert.doesNotMatch(html, /onerror=/);
});

void test('引用画像デコレーションに相対リンクを混在させない', () => {
  const output = renderOne('[" https://example.com/a.png [relative.png]]');
  assert.match(output, /<span><img src="https:\/\/example\.com\/a\.png"/);
  assert.doesNotMatch(output, /relative\.png/);
});

void test('コードブロックは複数物理行を 1 ブロックとして消費し、各物理行に対応する html を生成する', () => {
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

void test('コードブロックのヘッダ直後が非インデント行なら本体0行として扱う', () => {
  const lines = [
    { id: 'title', text: 'Title' },
    { id: 'l1', text: 'code:a.js' },
    { id: 'l2', text: 'after' },
  ];
  const out = renderLines(lines, new Map(), 'proj', cfg);
  assert.deepEqual(out.map((line) => line.lineId), ['title', 'l1', 'l2']);
  assert.match(String(out[1]!.html), /class="code-header"/);
  assert.equal(String(out[2]!.html), '<div>after</div>');
});

void test('コードブロックの空白のみの本体1行も物理行と対応させる', () => {
  const lines = [
    { id: 'title', text: 'Title' },
    { id: 'l1', text: 'code:a.js' },
    { id: 'l2', text: ' ' },
    { id: 'l3', text: 'after' },
  ];
  const out = renderLines(lines, new Map(), 'proj', cfg);
  assert.deepEqual(out.map((line) => line.lineId), ['title', 'l1', 'l2', 'l3']);
  assert.equal(String(out[1]!.html), '<div class="code-header">a.js</div>');
  assert.equal(String(out[2]!.html), '<div class="code-line"></div>');
  assert.equal(String(out[3]!.html), '<div>after</div>');
});

void test('コードブロックの複数の空白行をそれぞれ物理行と対応させる', () => {
  const lines = [
    { id: 'title', text: 'Title' },
    { id: 'l1', text: 'code:a.js' },
    { id: 'l2', text: ' ' },
    { id: 'l3', text: '  ' },
    { id: 'l4', text: ' value' },
    { id: 'l5', text: 'after' },
  ];
  const out = renderLines(lines, new Map(), 'proj', cfg);
  assert.deepEqual(out.map((line) => line.lineId), ['title', 'l1', 'l2', 'l3', 'l4', 'l5']);
  assert.equal(String(out[2]!.html), '<div class="code-line"></div>');
  assert.equal(String(out[3]!.html), '<div class="code-line"> </div>');
  assert.equal(String(out[4]!.html), '<div class="code-line">value</div>');
  assert.equal(String(out[5]!.html), '<div>after</div>');
});

void test('インデント付きコードブロックはヘッダより深い行だけを消費する', () => {
  const lines = [
    { id: 'title', text: 'Title' },
    { id: 'l1', text: '\u3000code:a.js' },
    { id: 'l2', text: '\u3000\u3000value' },
    { id: 'l3', text: '\u3000after' },
  ];
  const out = renderLines(lines, new Map(), 'proj', cfg);
  assert.deepEqual(out.map((line) => line.lineId), ['title', 'l1', 'l2', 'l3']);
  assert.equal(String(out[2]!.html), '<div class="code-line">value</div>');
  assert.equal(String(out[3]!.html), '<div>after</div>');
});

void test('テーブルも複数物理行を 1 ブロックとして消費する', () => {
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

void test('テーブルの空白のみの本体行も物理行と対応させる', () => {
  const lines = [
    { id: 'title', text: 'Title' },
    { id: 'l1', text: 'table:t' },
    { id: 'l2', text: ' ' },
    { id: 'l3', text: 'after' },
  ];
  const out = renderLines(lines, new Map(), 'proj', cfg);
  assert.deepEqual(out.map((line) => line.lineId), ['title', 'l1', 'l2', 'l3']);
  assert.match(String(out[2]!.html), /class="table-row"/);
  assert.equal(String(out[3]!.html), '<div>after</div>');
});

void test('アップロード画像(/files/ の相対URL)は allowlist なしで img にする', () => {
  assert.match(
    renderOne('[/files/01ABC/x.png]', [], { allowedImageHosts: [], allowedMediaHosts: [] }),
    /<img src="\/files\/01ABC\/x\.png"/,
  );
});

void test('/files/ の画像以外のファイルはリンクにする', () => {
  assert.match(renderOne('[/files/01ABC/doc.pdf]'), /<a href="\/files\/01ABC\/doc\.pdf">/);
  assert.doesNotMatch(renderOne('[/files/01ABC/doc.pdf]'), /<img/);
});

void test('/files/ 以外のルートパスは従来どおり平文のまま', () => {
  const out = renderOne('[/elsewhere/x.png]');
  assert.doesNotMatch(out, /<img|<a /);
});

void test('許可ホストの #.png フラグメント付きURLも img にする', () => {
  const config = { allowedImageHosts: ['lh3.googleusercontent.com'], allowedMediaHosts: [] };
  assert.match(
    renderOne('https://lh3.googleusercontent.com/a/xyz=s96-c#.png', [], config),
    /<img src="https:\/\/lh3\.googleusercontent\.com\/a\/xyz=s96-c#\.png"/,
  );
});

void test('画像URL(拡張子)は img、Gyazoホストも img', () => {
  assert.match(renderOne('https://i.gyazo.com/abc.png'), /<img src="https:\/\/i\.gyazo\.com\/abc\.png"/);
  assert.match(renderOne('https://example.com/a.png'), /<img src="https:\/\/example\.com\/a\.png"/);
});

void test('許可されていないホストの画像URLは通常リンクにする', () => {
  const output = renderOne('https://blocked.example/a.png', [], {
    allowedImageHosts: ['example.com'],
    allowedMediaHosts: [],
  });
  assert.doesNotMatch(output, /<img/);
  assert.match(
    output,
    /<a href="https:\/\/blocked\.example\/a\.png" rel="noopener noreferrer">https:\/\/blocked\.example\/a\.png<\/a>/,
  );
});

void test('allowedImageHosts のワイルドカードはサブドメインにだけ一致する', () => {
  const config = { allowedImageHosts: ['*.example.com'], allowedMediaHosts: [] };
  assert.match(renderOne('https://cdn.assets.example.com/a.png', [], config), /<img /);
  assert.doesNotMatch(renderOne('https://example.com/a.png', [], config), /<img /);
});

void test('動画URLは video controls、音声は audio controls', () => {
  assert.match(
    renderOne('https://example.com/a.mp4'),
    /<video controls><source src="https:\/\/example\.com\/a\.mp4"><\/video>/,
  );
  assert.match(
    renderOne('https://example.com/a.mp3'),
    /<audio controls><source src="https:\/\/example\.com\/a\.mp3"><\/audio>/,
  );
});

void test('動画と音声は allowedMediaHosts で許可したホストだけ埋め込む', () => {
  const blockedConfig = { allowedImageHosts: [], allowedMediaHosts: [] };
  assert.doesNotMatch(renderOne('https://media.example.com/a.mp4', [], blockedConfig), /<video/);
  assert.doesNotMatch(renderOne('https://media.example.com/a.mp3', [], blockedConfig), /<audio/);

  const allowedConfig = { allowedImageHosts: [], allowedMediaHosts: ['media.example.com'] };
  assert.match(renderOne('https://media.example.com/a.mp4', [], allowedConfig), /<video controls>/);
  assert.match(renderOne('https://media.example.com/a.mp3', [], allowedConfig), /<audio controls>/);
});

void test('YouTube等は既定で埋め込まず通常リンク（iframe は生成しない）', () => {
  const out = renderOne('https://www.youtube.com/watch?v=abc');
  assert.doesNotMatch(out, /<iframe/);
  assert.match(
    out,
    /<a href="https:\/\/www\.youtube\.com\/watch\?v=abc" rel="noopener noreferrer">https:\/\/www\.youtube\.com\/watch\?v=abc<\/a>/,
  );
});

void test('非http(s)スキームのメディアURLはリンク化・img化されず平文のまま', () => {
  const out = renderOne('file:///etc/passwd.png');
  assert.doesNotMatch(out, /<img|<a |<video|<audio/);
  assert.match(out, /file:\/\/\/etc\/passwd\.png/);
});

void test('[Name.icon] は known page に image があれば img で表示する', () => {
  const lines = [
    { id: 'title', text: 'Title' },
    { id: 'l1', text: '[Foo.icon]' },
  ];
  const map = new Map([['foo', { title: 'Foo', image: 'https://i.gyazo.com/icon.png' }]]);
  const out = renderLines(lines, map, 'proj', cfg);
  const result = String(out[1]!.html);
  assert.match(
    result,
    /<a href="\/proj\/Foo" class="icon-link"><img src="https:\/\/i\.gyazo\.com\/icon\.png" alt="Foo" class="icon-img"><\/a>/,
  );
});

void test('[Name.icon] は image が許可ホスト外ならブラケット表示に戻す', () => {
  const lines = [
    { id: 'title', text: 'Title' },
    { id: 'l1', text: '[Foo.icon]' },
  ];
  const map = new Map([['foo', { title: 'Foo', image: 'https://blocked.example/icon.png' }]]);
  const out = renderLines(lines, map, 'proj', { allowedImageHosts: ['example.com'], allowedMediaHosts: [] });
  const result = String(out[1]!.html);
  assert.doesNotMatch(result, /<img/);
  assert.match(result, /<a href="\/proj\/Foo" class="icon-link">\[Foo\]<\/a>/);
});
