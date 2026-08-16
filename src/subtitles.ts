import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { resolveSafePath, sha256File } from './utils.js';
import { UserError } from './user-error.js';

const execFileAsync = promisify(execFile);

export const SUBTITLE_MAX_CUES = 20;
export const SUBTITLE_MAX_TEXT_LENGTH = 100;

const HEX_COLOR = z.string().regex(/^#?[0-9A-Fa-f]{6}$/);

function normalizeHex(hex: string): string {
  return (hex.startsWith('#') ? hex.slice(1) : hex).toUpperCase();
}

function colorToFFmpeg(hex: string): string {
  return `0x${normalizeHex(hex)}`;
}

function colorToFFmpegWithAlpha(hex: string, alpha: number): string {
  const color = colorToFFmpeg(hex);
  return alpha === 1 ? color : `${color}@${alpha}`;
}

export const SubtitleCueSchema = z
  .object({
    start: z.number().nonnegative().finite(),
    end: z.number().nonnegative().finite(),
    text: z.string().min(1).max(SUBTITLE_MAX_TEXT_LENGTH),
    x: z.number().int().finite(),
    y: z.number().int().finite(),
    fontSize: z.number().int().min(1).max(200),
    fontColor: HEX_COLOR.default('#FFFFFF'),
    fontAlpha: z.number().min(0).max(1).default(1),
    borderWidth: z.number().int().min(0).max(20).default(0),
    borderColor: HEX_COLOR.default('#000000'),
    box: z.boolean().default(false),
    boxColor: HEX_COLOR.default('#000000'),
    boxAlpha: z.number().min(0).max(1).default(0.5),
    align: z.enum(['left', 'center', 'right']).default('left'),
    font: z.string().min(1).optional(),
    fontHash: z.string().length(64).regex(/^[0-9a-fA-F]{64}$/).optional(),
  })
  .refine((c) => c.start < c.end, {
    message: 'subtitle start must be less than end',
    path: ['end'],
  });

export type SubtitleCue = z.infer<typeof SubtitleCueSchema>;

export const DEFAULT_SUBTITLE_STYLE = {
  x: 540,
  y: 1500,
  fontSize: 100,
  fontColor: '#FFFFFF' as const,
  fontAlpha: 1,
  borderWidth: 0,
  borderColor: '#000000' as const,
  box: false,
  boxColor: '#000000' as const,
  boxAlpha: 0.5,
  align: 'left' as const,
};

export function withSubtitleDefaults(
  cue: Partial<SubtitleCue> & Pick<SubtitleCue, 'start' | 'end' | 'text'>,
): SubtitleCue {
  return { ...DEFAULT_SUBTITLE_STYLE, ...cue };
}

export interface ResolvedFont {
  fontFile: string;
  fontHash: string;
  fontFamily: string;
}

// This slice only supports single-face TrueType/OpenType fonts.
// TrueType/OpenType Collections (.ttc/.otc) contain multiple faces and
// require a face index/name contract, which is out of scope here.
const SUPPORTED_FONT_EXTS = ['.ttf', '.otf'];

function isSupportedFont(file: string): boolean {
  const ext = extname(file).toLowerCase();
  return SUPPORTED_FONT_EXTS.includes(ext);
}

// C0 control characters and C1 control characters are rejected.
// Tab (0x09), LF (0x0A) and CR (0x0D) are allowed as layout controls.
const DISALLOWED_CONTROLS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/;

const API_KEY_PATTERN =
  /(?:api[_-]?key|apikey|secret|token|password|passwd|credential|credentials|auth|bearer|sk-|sk_|private[_-]?key)[\s=:]*["']?[a-zA-Z0-9_+\-=]{8,}["']?/i;

export function validateCues(cues: Array<Partial<SubtitleCue> & { start: number; end: number; text: string }>, duration: number): void {
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('Video duration must be finite and positive to validate subtitles');
  }
  if (cues.length > SUBTITLE_MAX_CUES) {
    throw new UserError(
      'TOO_MANY_SUBTITLE_CUES',
      `Too many subtitle cues: ${cues.length} (max ${SUBTITLE_MAX_CUES})`,
      '字幕の数が多すぎます',
    );
  }
  for (const cue of cues) {
    if (cue.text.length === 0) {
      throw new Error('Subtitle text must not be empty');
    }
    if (cue.text.length > SUBTITLE_MAX_TEXT_LENGTH) {
      throw new Error(
        `Subtitle text too long: ${cue.text.length} characters (max ${SUBTITLE_MAX_TEXT_LENGTH})`,
      );
    }
    if (DISALLOWED_CONTROLS.test(cue.text)) {
      throw new Error('Subtitle text contains disallowed control characters');
    }
    if (cue.text.search(API_KEY_PATTERN) !== -1) {
      throw new Error('Subtitle text contains secret-like value');
    }
    if (!Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.start < 0 || cue.end < 0) {
      throw new Error('Subtitle cue times must be finite and non-negative');
    }
    if (cue.start >= cue.end) {
      throw new UserError(
        'SUBTITLE_CUE_START_AFTER_END',
        `Subtitle cue start (${cue.start}) must be less than end (${cue.end})`,
        '字幕の開始時間は終了時間より前である必要があります',
      );
    }
    if (cue.start > duration + 0.001) {
      throw new UserError(
        'SUBTITLE_CUE_START_EXCEEDS_VIDEO',
        `Subtitle cue start (${cue.start}) exceeds video duration (${duration})`,
        '字幕の開始時間が動画の長さを超えています',
      );
    }
    if (cue.end > duration + 0.001) {
      throw new UserError(
        'SUBTITLE_CUE_END_EXCEEDS_VIDEO',
        `Subtitle cue end (${cue.end}) exceeds video duration (${duration})`,
        '字幕の終了時間が動画の長さを超えています',
      );
    }
  }
}

export function collectCueText(cues: SubtitleCue[]): string {
  return cues.map((c) => c.text).join('');
}

function isAbsolute(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:[/\\]/.test(p);
}

export async function resolveFont(
  font: string,
  fontHash: string,
  fontsDir: string,
): Promise<ResolvedFont> {
  if (typeof font !== 'string' || font.length === 0) {
    throw new Error('Font identifier must be a non-empty string');
  }
  if (font.includes('\0')) {
    throw new Error('Font identifier must not contain null bytes');
  }
  if (isAbsolute(font)) {
    throw new Error('Absolute font paths are not allowed');
  }
  if (!isSupportedFont(font)) {
    throw new Error(
      `Font must be a single-face TrueType/OpenType file (.ttf or .otf) under the approved font root: ${font}`,
    );
  }

  const fontFile = resolveSafePath(fontsDir, font);
  const info = await stat(fontFile);
  if (!info.isFile()) {
    throw new UserError(
      'FONT_PATH_NOT_REGULAR_FILE',
      `Font path is not a regular file: ${font}`,
      'フォントファイルが見つかりません',
    );
  }

  if (typeof fontHash !== 'string' || !/^[0-9a-fA-F]{64}$/.test(fontHash)) {
    throw new Error('Timeline must specify a valid SHA-256 fontHash for the selected font');
  }
  const expectedHash = fontHash.toLowerCase();
  const actualHash = await sha256File(fontFile);
  if (actualHash !== expectedHash) {
    throw new UserError(
      'FONT_HASH_MISMATCH',
      `Font hash mismatch: expected ${expectedHash}, got ${actualHash}`,
      'フォントファイルの内容が変更されました',
    );
  }

  let fontFamily: string;
  try {
    const { stdout } = await execFileAsync('fc-query', ['-f', '%{family}\n', fontFile]);
    fontFamily = stdout.trim().split(',')[0] || font;
  } catch {
    fontFamily = font;
  }

  return { fontFile, fontHash: actualHash, fontFamily };
}

function parseCharsetRanges(charset: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const token of charset.split(/\s+/).filter(Boolean)) {
    if (token.includes('-')) {
      const [start, end] = token.split('-').map((h) => parseInt(h, 16));
      if (Number.isFinite(start) && Number.isFinite(end)) {
        ranges.push([start, end]);
      }
    } else {
      const code = parseInt(token, 16);
      if (Number.isFinite(code)) {
        ranges.push([code, code]);
      }
    }
  }
  return ranges;
}

const LAYOUT_CONTROLS = new Set([0x09, 0x0a, 0x0d]);

export async function verifyFontGlyphs(fontFile: string, text: string): Promise<void> {
  let charset: string;
  try {
    const { stdout } = await execFileAsync('fc-query', ['-f', '%{charset}\n', fontFile]);
    charset = stdout.trim();
  } catch (err) {
    throw new UserError(
      'FONT_GLYPH_COVERAGE_QUERY_FAILED',
      `Failed to query font glyph coverage: ${(err as Error).message}`,
      'フォントで使える文字を確認できませんでした',
    );
  }
  if (!charset) {
    throw new Error('Font glyph coverage information is empty');
  }

  const ranges = parseCharsetRanges(charset);
  function hasCodePoint(cp: number): boolean {
    for (const [start, end] of ranges) {
      if (cp >= start && cp <= end) return true;
    }
    return false;
  }

  for (const char of text) {
    const cp = char.codePointAt(0);
    if (cp === undefined) continue;
    if (LAYOUT_CONTROLS.has(cp)) continue;
    if (!hasCodePoint(cp)) {
      throw new Error(
        `Font does not contain glyph for character '${char}' (U+${cp.toString(16).toUpperCase()}) in subtitle text`,
      );
    }
  }
}

export async function prepareSubtitleWorkDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'svg-subtitles-'));
}

export async function writeCueTextFiles(cues: SubtitleCue[], tempDir: string): Promise<string[]> {
  const files: string[] = [];
  for (let i = 0; i < cues.length; i++) {
    const path = join(tempDir, `cue-${i}.txt`);
    await writeFile(path, cues[i].text, 'utf8');
    files.push(path);
  }
  return files;
}

function quoteFilterValue(value: string): string {
  // Wrap in single quotes and escape embedded single quotes and backslashes.
  const escaped = value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return `'${escaped}'`;
}

function buildX(cue: SubtitleCue): string {
  const x = Number.isFinite(cue.x) ? cue.x : 0;
  if (cue.align === 'center') return `(w-text_w)/2${x ? `+${x}` : ''}`;
  if (cue.align === 'right') return `w-text_w${x ? `-${x}` : ''}`;
  return String(x);
}

export function buildSubtitleFilter(
  cues: SubtitleCue[],
  cueTextFiles: string[],
  fontFiles: string[],
): string {
  if (cues.length === 0) return '';
  if (cueTextFiles.length !== cues.length || fontFiles.length !== cues.length) {
    throw new Error('Subtitle cue count must match text files and font files');
  }

  const parts: string[] = [];
  let inputLabel = 'v0';
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    const outputLabel = i === cues.length - 1 ? 'v' : `s${i + 1}`;
    const fontPath = quoteFilterValue(fontFiles[i]);
    const textPath = quoteFilterValue(cueTextFiles[i]);
    const fontColor = colorToFFmpeg(cue.fontColor);
    const x = buildX(cue);
    const fontAlpha = cue.fontAlpha === 1 ? '' : `:alpha=${cue.fontAlpha}`;
    const border = cue.borderWidth
      ? `:borderw=${cue.borderWidth}:bordercolor=${colorToFFmpeg(cue.borderColor)}`
      : '';
    const box = cue.box
      ? `:box=1:boxcolor=${colorToFFmpegWithAlpha(cue.boxColor, cue.boxAlpha)}`
      : '';
    const filter =
      `[${inputLabel}]drawtext=fontfile=${fontPath}:textfile=${textPath}:expansion=none:` +
      `fontcolor=${fontColor}:fontsize=${cue.fontSize}:x=${x}:y=${cue.y}` +
      `${fontAlpha}${border}${box}:` +
      `enable='between(t,${cue.start},${cue.end})'[${outputLabel}]`;
    parts.push(filter);
    inputLabel = outputLabel;
  }
  return parts.join(';');
}
