import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyUrl, isAllowedImageUrl } from '../../src/core/media.ts';

test('拡張子とホストで分類する', () => {
  assert.equal(classifyUrl('https://example.com/a.png'), 'image');
  assert.equal(classifyUrl('https://example.com/a.JPG'), 'image');
  assert.equal(classifyUrl('https://gyazo.com/0204f06d4ed4af1554dc3c2a87a806b2'), 'image');
  assert.equal(classifyUrl('https://example.com/v.mp4'), 'video');
  assert.equal(classifyUrl('https://example.com/a.mp3'), 'audio');
  assert.equal(classifyUrl('https://example.com/page'), 'other');
  assert.equal(classifyUrl('/files/abc/pic.webp'), 'image');
});

test('http/https 以外のスキームは other', () => {
  assert.equal(classifyUrl('javascript:alert(1)'), 'other');
  assert.equal(classifyUrl('data:image/png;base64,xxxx'), 'other');
});

test('isAllowedImageUrl: 完全一致とワイルドカードだけを許可する', () => {
  assert.equal(isAllowedImageUrl('https://images.example.com/a.png', ['images.example.com']), true);
  assert.equal(isAllowedImageUrl('https://cdn.example.com/a.png', ['*.example.com']), true);
  assert.equal(isAllowedImageUrl('https://example.com/a.png', ['*.example.com']), false);
  assert.equal(isAllowedImageUrl('https://blocked.example/a.png', ['example.com']), false);
  assert.equal(isAllowedImageUrl('data:image/png;base64,xxxx', ['example.com']), false);
});
