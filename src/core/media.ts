export type MediaKind = 'image' | 'video' | 'audio' | 'other';

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;
const VIDEO_EXT = /\.(mp4|webm)$/i;
const AUDIO_EXT = /\.(mp3|m4a|ogg|wav)$/i;
const IMAGE_HOSTS = new Set(['gyazo.com', 'i.gyazo.com']);

export function classifyUrl(url: string): MediaKind {
  let u: URL;
  try {
    u = new URL(url, 'http://knot.internal');
  } catch {
    return 'other';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'other';
  if (IMAGE_HOSTS.has(u.hostname)) return 'image';
  // Cosense 慣習: 拡張子のない URL に #.png 等を付けてメディア種別を宣言する
  if (IMAGE_EXT.test(u.pathname) || IMAGE_EXT.test(u.hash)) return 'image';
  if (VIDEO_EXT.test(u.pathname) || VIDEO_EXT.test(u.hash)) return 'video';
  if (AUDIO_EXT.test(u.pathname) || AUDIO_EXT.test(u.hash)) return 'audio';
  return 'other';
}

/** サイト内の添付ファイル配信パス（/files/<id>/<name>）か。allowlist 不要（img-src 'self' の圏内）。 */
export function isAttachmentUrl(url: string): boolean {
  return url.startsWith('/files/');
}

export function isHostAllowed(hostname: string, allowedHosts: string[]): boolean {
  const normalizedHostname = hostname.toLowerCase();
  return allowedHosts.some((allowedHost) => {
    const normalizedAllowedHost = allowedHost.toLowerCase();
    if (!normalizedAllowedHost.startsWith('*.')) return normalizedHostname === normalizedAllowedHost;
    const suffix = normalizedAllowedHost.slice(1);
    return normalizedHostname.endsWith(suffix) && normalizedHostname !== suffix.slice(1);
  });
}

export function isAllowedImageUrl(url: string, allowedHosts: string[]): boolean {
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && isHostAllowed(parsed.hostname, allowedHosts);
  } catch {
    return false;
  }
}
