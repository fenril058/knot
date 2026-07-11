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
  if (IMAGE_EXT.test(u.pathname)) return 'image';
  if (VIDEO_EXT.test(u.pathname)) return 'video';
  if (AUDIO_EXT.test(u.pathname)) return 'audio';
  return 'other';
}
