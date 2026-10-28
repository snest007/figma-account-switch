const MAX_BYTES = 1024 * 1024;

// Only public Figma profile images. Never forward OAuth tokens, cookies, or headers.
export async function downloadFigmaAvatar(value, fetchImage = fetch) {
  let url;
  try { url = new URL(value); } catch { throw new Error('头像地址无效。'); }
  if (url.protocol !== 'https:' || url.hostname !== 's3-alpha.figma.com' || url.port
    || url.username || url.password || url.search || url.hash
    || !/^\/profile\/[a-f0-9-]{36}$/.test(url.pathname)) {
    throw new Error('请使用 Figma 账号页面中的官方头像图片地址。');
  }
  const response = await fetchImage(url.href, {
    redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(12000)
  });
  if (!response.ok || !response.body) throw new Error('无法读取 Figma 头像，请重新从账号页面获取。');
  if (Number(response.headers.get('content-length')) > MAX_BYTES) {
    await response.body.cancel(); throw new Error('头像图片超过 1 MB。');
  }
  const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(type)) {
    await response.body.cancel(); throw new Error('头像必须为 PNG、JPEG 或 WebP 图片。');
  }
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value: chunk } = await reader.read(); if (done) break;
      size += chunk.byteLength;
      if (size > MAX_BYTES) throw new Error('头像图片超过 1 MB。');
      chunks.push(Buffer.from(chunk));
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const bytes = Buffer.concat(chunks);
  const png = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const webp = bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
  if (!(type === 'image/png' && png || type === 'image/jpeg' && jpeg || type === 'image/webp' && webp)) {
    throw new Error('头像图片内容无效。');
  }
  return { dataUrl: `data:${type};base64,${bytes.toString('base64')}`, sourceUrl: url.href };
}
