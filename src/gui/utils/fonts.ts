import { existsSync } from 'node:fs';
import { mkdir, readdir } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { prepareFonts } from '../../fixtures.js';
import { sha256File } from '../../utils.js';
import { verifyFontGlyphs } from '../../subtitles.js';
import { fontsDir, root } from '../paths.js';

export async function listAvailableFonts(): Promise<string[]> {
  return (await readdir(fontsDir))
    .filter((f) => {
      const lower = f.toLowerCase();
      return lower.endsWith('.ttf') || lower.endsWith('.otf');
    })
    .map((f) => resolve(fontsDir, f));
}

export async function resolveFontForText(
  text: string,
  preferredFont?: string,
): Promise<{ font: string; fontFile: string; fontHash: string }> {
  if (!existsSync(fontsDir)) {
    await mkdir(fontsDir, { recursive: true });
  }

  let files = await listAvailableFonts();

  if (files.length === 0) {
    try {
      await prepareFonts(root);
      files = await listAvailableFonts();
    } catch {
      throw new Error(
        '字幕を使うには fonts/ に .ttf/.otf フォントを配置するか、npm run setup:fonts を実行してください。',
      );
    }
  }

  if (files.length === 0) {
    throw new Error('字幕を使うには fonts/ に .ttf/.otf フォントを配置してください。');
  }

  if (preferredFont) {
    const preferredPath = files.find((f) => basename(f) === preferredFont);
    if (!preferredPath) {
      throw new Error(`指定されたフォントが見つかりません: ${preferredFont}`);
    }
    const hash = await sha256File(preferredPath);
    try {
      await verifyFontGlyphs(preferredPath, text);
    } catch {
      throw new Error(`指定されたフォントで字幕テキストを表示できません: ${preferredFont}`);
    }
    return { font: basename(preferredPath), fontFile: preferredPath, fontHash: hash };
  }

  const hasCjk = [...text].some((c) => {
    const cp = c.codePointAt(0) ?? 0;
    return (
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0x3040 && cp <= 0x309f) ||
      (cp >= 0x30a0 && cp <= 0x30ff) ||
      (cp >= 0xac00 && cp <= 0xd7af)
    );
  });

  files = files.sort((a, b) => {
    const aName = basename(a).toLowerCase();
    const bName = basename(b).toLowerCase();
    const aCjk = /ipa|gothic|mincho|noto|cjk|jpn|japanese/.test(aName) ? 1 : 0;
    const bCjk = /ipa|gothic|mincho|noto|cjk|jpn|japanese/.test(bName) ? 1 : 0;
    return bCjk - aCjk;
  });
  if (hasCjk) {
    const cjkFonts = files.filter((f) => /ipa|gothic|mincho|noto|cjk|jpn|japanese/.test(basename(f).toLowerCase()));
    if (cjkFonts.length > 0) files = cjkFonts;
  }

  for (const fontFile of files) {
    try {
      const hash = await sha256File(fontFile);
      await verifyFontGlyphs(fontFile, text);
      return { font: basename(fontFile), fontFile, fontHash: hash };
    } catch {
      continue;
    }
  }
  throw new Error('字幕テキストを表示できるフォントが見つかりません');
}
