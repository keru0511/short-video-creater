import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const guiDir = resolve(root, 'gui');
export const fixturesDir = resolve(guiDir, 'fixtures');
export const outputDir = resolve(guiDir, 'output');
export const fontsDir = resolve(root, 'fonts');
export const indexHtmlPath = resolve(root, 'src', 'gui', 'index.html');
