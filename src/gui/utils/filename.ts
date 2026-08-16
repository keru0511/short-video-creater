import { basename, extname } from 'node:path';

export const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff']);
export const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.webm', '.mkv', '.m4v', '.flv']);
export const AUDIO_EXTS = new Set(['.mp3', '.wav', '.aac', '.flac', '.m4a', '.ogg', '.wma', '.oga']);

export function sanitizeFilename(name: string): string {
  const base = basename(name).replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '');
  return base || 'file';
}

export function classifyFile(filename: string): 'image' | 'video' | 'audio' | 'unknown' {
  const ext = extname(filename).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  return 'unknown';
}

export function uploadedFileRole(name: string, type: 'image' | 'video' | 'audio' | 'unknown'): 'visual' | 'audio' | 'bgm' {
  if (name === 'bgm') return 'bgm';
  if (name === 'mainAudio') return 'audio';
  if (name.startsWith('clip-')) return 'visual';
  if (type === 'image' || type === 'video') return 'visual';
  if (type === 'audio') return 'audio';
  return 'visual';
}

export function makeUploadedAssetName(
  role: 'visual' | 'audio' | 'bgm',
  ext: string,
  counters: Record<string, number>,
): string {
  const index = counters[role] ?? 0;
  counters[role] = index + 1;
  const e = ext.startsWith('.') ? ext : ext ? `.${ext}` : '';
  return `asset-${role}-${index}${e}`;
}
