import { test } from 'node:test';
import assert from 'node:assert/strict';
import { knownPageMap, presentationLines, type PresentedNode } from '../../src/render/presentation.ts';

const config = {
  allowedImageHosts: ['images.example'],
  allowedMediaHosts: ['media.example'],
};

function bodyNodes(source: string, knownPages = knownPageMap([])): PresentedNode[] {
  const line = presentationLines(`Title\n${source}`, knownPages, 'proj', config)[1];
  assert.equal(line?.role, 'line');
  return line.nodes;
}

void test('既知ページを正規タイトルへ解決し、不在リンクと代表画像アイコンを区別する', () => {
  const knownPages = knownPageMap([{ title: 'Foo Page', image: 'https://images.example/foo.png' }]);
  const nodes = bodyNodes('[foo_page] [Missing] [Foo Page.icon]', knownPages);

  const links = nodes.filter((node) => node.type === 'link');
  assert.deepEqual(links.map((link) => [link.href, link.className]), [
    ['/proj/Foo_Page', undefined],
    ['/proj/Missing', 'empty-link'],
    ['/proj/Foo_Page', 'icon-link'],
  ]);
  const icon = links[2]?.children[0];
  assert.equal(icon?.type, 'image');
  if (icon?.type === 'image') assert.equal(icon.src, 'https://images.example/foo.png');
});

void test('引用画像装飾は許可された絶対画像だけを表示計画へ残す', () => {
  const nodes = bodyNodes('[" https://images.example/a.png [relative.png]]');
  assert.equal(nodes.length, 1);
  const decoration = nodes[0];
  assert.equal(decoration?.type, 'container');
  if (decoration?.type !== 'container') return;
  assert.deepEqual(decoration.children.map((child) => child.type), ['image']);
  const image = decoration.children[0];
  assert.equal(image?.type, 'image');
  if (image?.type === 'image') assert.equal(image.src, 'https://images.example/a.png');
});

void test('同じ本文でも周囲のブロック種別が変われば表示キーが変わる', () => {
  const tableLine = presentationLines('Title\ntable:t\n a\tb', new Map(), 'proj', config)[2];
  const plainLine = presentationLines('Title\nplainxx\n a\tb', new Map(), 'proj', config)[2];

  assert.equal(tableLine?.role, 'tableRow');
  assert.equal(plainLine?.role, 'line');
  assert.notEqual(tableLine?.renderKey, plainLine?.renderKey);
});

void test('危険なスキームと許可外メディアをリンク要素へ変換しない', () => {
  const unsafe = bodyNodes('[javascript:alert(1) click]');
  assert.equal(unsafe.some((node) => node.type === 'link'), false);

  const blocked = bodyNodes('https://blocked.example/a.png');
  assert.equal(blocked[0]?.type, 'link');
  const allowed = bodyNodes('https://media.example/a.mp4');
  assert.equal(allowed[0]?.type, 'video');
});
