import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadFigmaAvatar } from '../src/avatar.mjs';

const url = 'https://s3-alpha.figma.com/profile/ebfda3f7-67e7-4cd9-82eb-e0f320154be8';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');

test('avatar download stays on the official public profile host without credentials', async () => {
  const image = await downloadFigmaAvatar(url, async (input, options) => {
    assert.equal(input, url); assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error'); assert.equal(options.headers, undefined);
    return new Response(png, { headers: { 'Content-Type': 'image/png' } });
  });
  assert.equal(image.sourceUrl, url); assert.equal(image.dataUrl, 'data:image/png;base64,' + png.toString('base64'));
  for (const bad of ['http://127.0.0.1/profile/x', url.replace('s3-alpha.figma.com', 's3-alpha.figma.com.evil.example'), url + '?token=secret', url.replace('/profile/', '/other/')]) {
    await assert.rejects(downloadFigmaAvatar(bad, () => { assert.fail('Must not fetch rejected URLs'); }));
  }
});

test('avatar rejects active content, disguised content and oversized streams', async () => {
  for (const [body, type] of [['<svg></svg>', 'image/svg+xml'], ['<html>error</html>', 'image/png'], [Buffer.alloc(1024 * 1024 + 1), 'image/jpeg']]) {
    await assert.rejects(downloadFigmaAvatar(url, async () => new Response(body, { headers: { 'Content-Type': type } })));
  }
});
