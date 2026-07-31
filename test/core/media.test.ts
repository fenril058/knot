import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyUrl, isAllowedImageUrl, isAttachmentUrl } from '../../src/core/media.ts';

void test('isAttachmentUrl: サイト内 /files/ のルートパスだけを添付として扱う', () => {
  assert.equal(isAttachmentUrl('/files/01ABC/x.png'), true);
  assert.equal(isAttachmentUrl('/files/01ABC/doc.pdf'), true);
  assert.equal(isAttachmentUrl('/elsewhere/x.png'), false);
  assert.equal(isAttachmentUrl('https://example.com/files/x.png'), false);
  assert.equal(isAttachmentUrl('files/x.png'), false);
});

void test('拡張子とホストで分類する', () => {
  assert.equal(classifyUrl('https://example.com/a.png'), 'image');
  assert.equal(classifyUrl('https://example.com/a.JPG'), 'image');
  assert.equal(classifyUrl('https://gyazo.com/0204f06d4ed4af1554dc3c2a87a806b2'), 'image');
  assert.equal(classifyUrl('https://example.com/v.mp4'), 'video');
  assert.equal(classifyUrl('https://example.com/a.mp3'), 'audio');
  assert.equal(classifyUrl('https://example.com/page'), 'other');
  assert.equal(classifyUrl('/files/abc/pic.webp'), 'image');
});

void test('Cosense 慣習の #.png フラグメントは画像として分類する', () => {
  assert.equal(classifyUrl('https://lh3.googleusercontent.com/a/ACg8oc=s96-c#.png'), 'image');
  assert.equal(classifyUrl('https://example.com/stream#.mp4'), 'video');
  assert.equal(classifyUrl('https://example.com/page#section'), 'other');
});

void test('http/https 以外のスキームは other', () => {
  assert.equal(classifyUrl('javascript:alert(1)'), 'other');
  assert.equal(classifyUrl('data:image/png;base64,xxxx'), 'other');
});

void test('isAllowedImageUrl: 完全一致とワイルドカードだけを許可する', () => {
  assert.equal(isAllowedImageUrl('https://images.example.com/a.png', ['images.example.com']), true);
  assert.equal(isAllowedImageUrl('https://cdn.example.com/a.png', ['*.example.com']), true);
  assert.equal(isAllowedImageUrl('https://example.com/a.png', ['*.example.com']), false);
  assert.equal(isAllowedImageUrl('https://blocked.example/a.png', ['example.com']), false);
  assert.equal(isAllowedImageUrl('data:image/png;base64,xxxx', ['example.com']), false);
});
