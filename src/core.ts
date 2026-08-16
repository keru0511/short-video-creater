import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { resolveSafePath, sha256File } from './utils.js';
import { UserError } from './user-error.js';
import {
  EffectiveEncodingSettings,
  getEffectiveEncoding,
  getEncodingArgs,
  OutputPresetName,
  OutputPresetSchema,
  resolveOutputPreset,
} from './output-presets.js';
import {
  buildSubtitleFilter,
  collectCueText,
  prepareSubtitleWorkDir,
  resolveFont,
  ResolvedFont,
  SubtitleCueSchema,
  SUBTITLE_MAX_CUES,
  validateCues,
  verifyFontGlyphs,
  writeCueTextFiles,
} from './subtitles.js';
import {
  buildVisualChain,
  quantizeTransitionDuration,
  TransitionSchema,
  type TransitionValidationResult,
  validateTransitions,
} from './transitions.js';

const execFileAsync = promisify(execFile);

function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Object.isFrozen(obj)) return obj;
  Object.freeze(obj);
  if (Array.isArray(obj)) {
    for (const item of obj) deepFreeze(item);
  } else {
    for (const key of Object.keys(obj as Record<string, unknown>)) {
      deepFreeze((obj as Record<string, unknown>)[key]);
    }
  }
  return obj;
}

export const FitSchema = z.enum(['cover', 'contain']).default('cover');

export const BgmSchema = z
  .object({
    source: z.string().min(1),
    start: z.number().nonnegative().finite(),
    in: z.number().nonnegative().finite(),
    out: z.number().nonnegative().finite(),
    volume: z.number().finite().min(0).max(1).default(1),
  })
  .refine((b) => b.in < b.out, {
    message: 'bgm in must be less than out',
    path: ['out'],
  });

export type Bgm = z.infer<typeof BgmSchema>;

export const ClipSchema = z
  .object({
    type: z.enum(['image', 'video', 'audio']),
    source: z.string().min(1),
    start: z.number().nonnegative().finite(),
    end: z.number().nonnegative().finite(),
    in: z.number().nonnegative().finite(),
    out: z.number().nonnegative().finite(),
    fit: FitSchema,
    x: z.number().optional(),
    y: z.number().optional(),
    scale: z.number().min(0.1).max(5).optional(),
  })
  .refine((c) => c.in < c.out, { message: 'in must be less than out', path: ['out'] })
  .refine((c) => c.start < c.end, { message: 'start must be less than end', path: ['end'] });

export const TimelineSchema = z
  .object({
    width: z.union([z.literal(720), z.literal(1080)]),
    height: z.union([z.literal(1280), z.literal(1920)]),
    fps: z.number().int().min(1).max(60).default(30),
    outputPath: z.string().min(1),
    background: z.string().regex(/^[0-9A-Fa-f]{6}$/).default('000000'),
    clips: z.array(ClipSchema).min(1).max(10),
    subtitles: z.array(SubtitleCueSchema).max(SUBTITLE_MAX_CUES).optional(),
    bgm: BgmSchema.optional(),
    transitions: z.array(TransitionSchema).max(4).optional(),
    outputPreset: OutputPresetSchema,
    font: z.string().min(1).optional(),
    fontHash: z.string().length(64).regex(/^[0-9a-fA-F]{64}$/).optional(),
  })
  .refine(
    (t) =>
      (t.width === 720 && t.height === 1280) || (t.width === 1080 && t.height === 1920),
    {
      message: 'Dimensions must be 720x1280 or 1080x1920',
      path: ['height'],
    },
  );

export type Timeline = z.infer<typeof TimelineSchema>;
export type Clip = z.infer<typeof ClipSchema>;
export type Fit = z.infer<typeof FitSchema>;
export type Transition = z.infer<typeof TransitionSchema>;

export { resolveSafePath, sha256File, isInside } from './utils.js';
export { MAX_TRANSITION_DURATION_SECONDS, TransitionSchema, validateTransitions } from './transitions.js';

interface FfprobeStream {
  index?: number;
  codec_name?: string;
  codec_type?: string;
  width?: number;
  height?: number;
  duration?: string;
  pix_fmt?: string;
  sample_rate?: string;
  channels?: number;
  avg_frame_rate?: string;
}
interface FfprobeResult {
  streams: FfprobeStream[];
  format?: { duration?: string };
}

export interface ProbeInfo {
  width: number | undefined;
  height: number | undefined;
  fps: number | undefined;
  videoCodec: string | undefined;
  audioCodec: string | undefined;
  sampleRate: number | undefined;
  duration: number;
  hasVideo: boolean;
  hasAudio: boolean;
}

function parseDurationString(value: string | undefined): number {
  if (value === undefined) return NaN;
  if (value.includes(':')) {
    const parts = value.split(':').map(Number);
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return Number(value);
}

function parseFrameRate(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (value.includes('/')) {
    const [num, den] = value.split('/').map(Number);
    if (!Number.isFinite(den) || den === 0) return undefined;
    const rate = num / den;
    return Number.isFinite(rate) ? rate : undefined;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

export async function ffprobe(filePath: string): Promise<ProbeInfo> {
  const { stdout } = await execFileAsync(
    'ffprobe',
    ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath],
    { maxBuffer: 10 * 1024 * 1024 },
  );
  const parsed: FfprobeResult = JSON.parse(stdout);
  const video = parsed.streams.find((s) => s.codec_type === 'video');
  const audio = parsed.streams.find((s) => s.codec_type === 'audio');
  const durationStr = parsed.format?.duration ?? video?.duration ?? audio?.duration;
  return {
    width: video?.width,
    height: video?.height,
    fps: parseFrameRate(video?.avg_frame_rate),
    videoCodec: video?.codec_name,
    audioCodec: audio?.codec_name,
    sampleRate: audio?.sample_rate ? Number(audio.sample_rate) : undefined,
    duration: parseDurationString(durationStr),
    hasVideo: video !== undefined,
    hasAudio: audio !== undefined,
  };
}

function getSourceDuration(source: string, probe: ProbeInfo): number {
  if (Number.isFinite(probe.duration) && probe.duration > 0) return probe.duration;
  return Infinity;
}

async function getAudioPeak(
  source: string,
  startSec = 0,
  durationSec?: number,
): Promise<number> {
  const args = ['-ss', String(startSec), '-i', source, '-vn', '-ar', '48000', '-ac', '2', '-f', 'f32le'];
  if (durationSec !== undefined) args.push('-t', String(durationSec));
  args.push('-');
  const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let peak = 0;
  let leftover = Buffer.alloc(0);
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.stdout.on('data', (chunk: Buffer) => {
    const buf = Buffer.concat([leftover, chunk]);
    const floatCount = Math.floor(buf.length / 4);
    const floats = new Float32Array(buf.buffer, buf.byteOffset, floatCount);
    for (let i = 0; i < floats.length; i++) {
      const v = Math.abs(floats[i]);
      if (Number.isNaN(v)) {
        child.kill();
        stderr = `Audio peak contains NaN: ${source}`;
      }
      if (v > peak) peak = v;
    }
    leftover = buf.subarray(floatCount * 4);
  });
  const [code] = await once(child, 'close');
  if (code !== 0) {
    throw new UserError(
      'AUDIO_PEAK_DETECTION_FAILED',
      `Could not determine audio peak for ${source}: ${stderr || 'unknown'}`,
      '音声ピークを検出できませんでした',
    );
  }
  return peak;
}

export interface VisualInput {
  source: string;
  type: 'image' | 'video';
  fit: Fit;
  in: number;
  duration: number;
  x: number;
  y: number;
  scale: number;
}

export interface ValidatedTimeline {
  timeline: Timeline;
  resolvedOutput: string;
  visualInputs: VisualInput[];
  audioClip: { source: string; in: number; duration: number } | undefined;
  bgm?: {
    source: string;
    in: number;
    duration: number;
    start: number;
    startSamples: number;
    volume: number;
    sampleRate: number;
    loopSamples: number;
  };
  duration: number;
  transitionDurations?: number[];
  font?: ResolvedFont;
  subtitleFonts?: ResolvedFont[];
}

export async function validateTimeline(
  input: unknown,
  options: { rootDir: string; fixturesDir: string; outputDir: string; fontsDir: string },
): Promise<ValidatedTimeline> {
  const timeline = TimelineSchema.parse(input);

  const resolvedOutput = resolveSafePath(options.outputDir, timeline.outputPath, {
    allowNonexistent: true,
  });

  const visualClips = timeline.clips.filter(
    (c): c is Clip & { type: 'image' | 'video' } =>
      c.type === 'image' || c.type === 'video',
  );
  const audioClips = timeline.clips.filter((c) => c.type === 'audio');

  if (visualClips.length === 0) {
    throw new UserError(
      'TIMELINE_MISSING_VISUAL_CLIP',
      'Timeline must contain at least one image or video clip',
      'タイムラインには画像か動画のクリップが1つ以上必要です',
    );
  }
  if (visualClips.length > 5) {
    throw new UserError(
      'TIMELINE_TOO_MANY_VISUAL_CLIPS',
      'Timeline must contain at most 5 visual clips',
      '画像・動画は最大5つまでです',
    );
  }
  if (audioClips.length > 1) {
    throw new UserError(
      'MULTIPLE_AUDIO_CLIPS',
      'Multiple audio clips are not supported in this core slice',
      '音声クリップは1つまでです',
    );
  }

  for (const clip of timeline.clips) {
    if (clip.start >= clip.end) {
      throw new UserError(
        'CLIP_INVALID_DURATION',
        `Clip ${clip.source} has invalid duration (start >= end)`,
        'クリップの開始・終了位置が不正です',
      );
    }
    if (clip.in >= clip.out) {
      throw new UserError(
        'CLIP_INVALID_IN_OUT',
        `Clip ${clip.source} has invalid in/out (in >= out)`,
        'クリップの開始・終了位置が不正です',
      );
    }
    if (Math.abs(clip.end - clip.start - (clip.out - clip.in)) > 0.001) {
      throw new UserError(
        'CLIP_IN_OUT_RANGE_MISMATCH',
        `Clip ${clip.source} in/out range must match timeline duration`,
        'クリップのトリム範囲と長さが一致しません',
      );
    }
  }

  if (visualClips[0].start !== 0) {
    throw new UserError(
      'FIRST_VISUAL_CLIP_START_NOT_ZERO',
      'First visual clip start must be 0',
      '最初のクリップは開始位置0秒からにしてください',
    );
  }

  for (let i = 1; i < visualClips.length; i++) {
    const prev = visualClips[i - 1];
    const curr = visualClips[i];
    const diff = curr.start - prev.end;
    if (Math.abs(diff) > 0.001) {
      if (diff > 0) {
        throw new Error(
          `Gap between visual clips at ${prev.end}s and ${curr.start}s`,
        );
      }
      throw new Error(
        `Visual clips overlap or are out of order at ${curr.start}s (previous ends at ${prev.end}s)`,
      );
    }
  }

  const visualInputs: VisualInput[] = [];
  for (const clip of visualClips) {
    const source = resolveSafePath(options.fixturesDir, clip.source);
    if (clip.type === 'video') {
      const probe = await ffprobe(source);
      const srcDuration = getSourceDuration(source, probe);
      if (clip.out > srcDuration + 0.001) {
        throw new UserError(
          'VISUAL_CLIP_EXCEEDS_SOURCE',
          `Visual clip out (${clip.out}) exceeds source duration (${srcDuration})`,
          '指定範囲が素材の長さを超えています',
        );
      }
    }
    visualInputs.push({
      source,
      type: clip.type,
      fit: clip.fit,
      in: clip.in,
      duration: clip.end - clip.start,
      x: clip.x ?? 0,
      y: clip.y ?? 0,
      scale: clip.scale ?? 1,
    });
  }

  const { totalDuration: totalTransitionDuration, effectiveDurations: transitionDurations } =
    validateTransitions(timeline.transitions, visualInputs, timeline.fps);
  const baseDuration = visualClips[visualClips.length - 1].end - visualClips[0].start;
  const duration = baseDuration - totalTransitionDuration;

  let font: ResolvedFont | undefined;
  let subtitleFonts: ResolvedFont[] | undefined;
  if (timeline.subtitles && timeline.subtitles.length > 0) {
    validateCues(timeline.subtitles, duration);
    const resolvedFontCache = new Map<string, ResolvedFont>();
    subtitleFonts = [];
    for (let i = 0; i < timeline.subtitles.length; i++) {
      const cue = timeline.subtitles[i];
      const cueFont = cue.font ?? timeline.font;
      const cueFontHash = cue.fontHash ?? timeline.fontHash;
      if (!cueFont || !cueFontHash) {
        throw new Error(
          `Subtitle cue ${i + 1} must specify a font and fontHash, or the timeline must specify a global font`,
        );
      }
      const cacheKey = `${cueFont}:${cueFontHash}`;
      let resolved = resolvedFontCache.get(cacheKey);
      if (!resolved) {
        resolved = await resolveFont(cueFont, cueFontHash, options.fontsDir);
        resolvedFontCache.set(cacheKey, resolved);
      }
      await verifyFontGlyphs(resolved.fontFile, cue.text);
      subtitleFonts.push(resolved);
    }
    if (subtitleFonts.length > 0) {
      font = subtitleFonts[0];
    }
  }

  let audioClip: ValidatedTimeline['audioClip'];
  if (audioClips.length === 1) {
    const audio = audioClips[0];
    if (audio.start !== 0) {
      throw new UserError(
        'AUDIO_START_NOT_ZERO',
        'Audio start must be 0 in this core slice',
        '音声は開始位置0秒からにしてください',
      );
    }
    if (Math.abs(audio.end - duration) > 0.001) {
      throw new Error(
        `Audio clip end (${audio.end}) must match total visual duration (${duration})`,
      );
    }
    const source = resolveSafePath(options.fixturesDir, audio.source);
    const probe = await ffprobe(source);
    const srcDuration = getSourceDuration(source, probe);
    if (audio.out > srcDuration + 0.001) {
      throw new UserError(
        'AUDIO_CLIP_EXCEEDS_SOURCE',
        `Audio clip out (${audio.out}) exceeds source duration (${srcDuration})`,
        '主音声の終了位置が素材の長さを超えています',
      );
    }
    audioClip = { source, in: audio.in, duration: audio.end - audio.start };
  }

  let bgm: ValidatedTimeline['bgm'];
  if (timeline.bgm) {
    const bgmSource = resolveSafePath(options.fixturesDir, timeline.bgm.source);
    const probe = await ffprobe(bgmSource);
    if (!probe.hasAudio) {
      throw new UserError(
        'BGM_NO_AUDIO_STREAM',
        `BGM source must contain an audio stream: ${timeline.bgm.source}`,
        'BGMファイルに音声ストリームがありません',
      );
    }
    const srcDuration = getSourceDuration(bgmSource, probe);
    if (!Number.isFinite(srcDuration) || srcDuration <= 0) {
      throw new UserError(
        'BGM_NO_USABLE_DURATION',
        `BGM source has no usable duration: ${timeline.bgm.source}`,
        'BGMファイルの長さを取得できません',
      );
    }
    if (timeline.bgm.out > srcDuration + 0.001) {
      throw new UserError(
        'BGM_OUT_EXCEEDS_SOURCE',
        `BGM out (${timeline.bgm.out}) exceeds source duration (${srcDuration})`,
        '指定範囲が素材の長さを超えています',
      );
    }
    const bgmDuration = timeline.bgm.out - timeline.bgm.in;

    const sampleRate = probe.sampleRate;
    if (!sampleRate || !Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw new UserError(
        'BGM_NO_USABLE_SAMPLE_RATE',
        `BGM source has no usable sample rate: ${timeline.bgm.source}`,
        'BGMファイルのサンプリングレートが取得できません',
      );
    }
    const loopSamples = Math.round(bgmDuration * sampleRate);
    if (loopSamples < 1) {
      throw new Error(
        `BGM selection is too short to contain one audio sample: duration=${bgmDuration}, sampleRate=${sampleRate}`,
      );
    }

    const startSamples = Math.round(timeline.bgm.start * sampleRate);
    const effectiveStart = startSamples / sampleRate;
    if (effectiveStart >= duration + 0.001) {
      throw new Error(
        `BGM start (${effectiveStart}s) exceeds video duration (${duration})`,
      );
    }
    if (effectiveStart + bgmDuration > duration + 0.001) {
      throw new Error(
        `BGM end (${effectiveStart + bgmDuration}) exceeds video duration (${duration})`,
      );
    }

    let mainOverlapStart = 0;
    let mainOverlapDuration = 0;
    if (audioClip) {
      mainOverlapStart = audioClip.in + effectiveStart;
      mainOverlapDuration = audioClip.duration - effectiveStart;
      if (mainOverlapDuration < 0) mainOverlapDuration = 0;
    }
    const [mainPeak, bgmPeak] = await Promise.all([
      audioClip && mainOverlapDuration > 0
        ? getAudioPeak(audioClip.source, mainOverlapStart, mainOverlapDuration)
        : 0,
      getAudioPeak(bgmSource, timeline.bgm.in, bgmDuration),
    ]);
    const mixPeak = mainPeak + timeline.bgm.volume * bgmPeak;
    if (mixPeak > 1.0) {
      throw new UserError(
        'BGM_MIX_EXCEEDS_FULL_SCALE',
        `BGM mix would exceed full scale: mainPeak=${mainPeak.toFixed(4)}, bgmPeak=${bgmPeak.toFixed(4)}, volume=${timeline.bgm.volume}`,
        'BGM音量が大きすぎます',
      );
    }

    bgm = {
      source: bgmSource,
      in: timeline.bgm.in,
      duration: bgmDuration,
      start: effectiveStart,
      startSamples,
      volume: timeline.bgm.volume,
      sampleRate,
      loopSamples,
    };
  }

  const allInputs = [
    ...visualInputs.map((v) => v.source),
    ...(audioClip ? [audioClip.source] : []),
    ...(bgm ? [bgm.source] : []),
  ];
  if (allInputs.includes(resolvedOutput)) {
    throw new Error('Output path must not overlap an input source');
  }

  if (existsSync(resolvedOutput)) {
    const outputStat = await stat(resolvedOutput);
    for (const source of allInputs) {
      const sourceStat = await stat(source);
      if (sourceStat.dev === outputStat.dev && sourceStat.ino === outputStat.ino) {
        throw new Error('Output path must not be a hard link to an input source');
      }
    }
  }

  return { timeline, resolvedOutput, visualInputs, audioClip, bgm, duration, transitionDurations, font, subtitleFonts };
}

export interface BuildFfmpegOptions {
  visualInputs: VisualInput[];
  audioClip: { source: string; in: number; duration: number } | undefined;
  bgm?: {
    source: string;
    in: number;
    duration: number;
    start: number;
    startSamples: number;
    volume: number;
    sampleRate: number;
    loopSamples: number;
  };
  duration: number;
  transitionDurations?: number[];
  resolvedOutput: string;
  subtitleFiles?: string[];
  fontFiles?: string[];
}

export function buildFfmpegCommand(
  timeline: Timeline,
  options: BuildFfmpegOptions,
): string[] {
  const { visualInputs, audioClip, bgm, duration, resolvedOutput, subtitleFiles, fontFiles } = options;
  const bg = `0x${timeline.background.toUpperCase()}`;

  const transitionDurations =
    options.transitionDurations ??
    (timeline.transitions?.map((t) => quantizeTransitionDuration(t.duration, timeline.fps)) ?? []);

  const args: string[] = ['-y'];
  for (const visual of visualInputs) {
    const isImage = visual.type === 'image';
    if (isImage) {
      args.push('-loop', '1');
    }
    if (visual.in > 0 || !isImage) {
      args.push('-ss', String(visual.in));
    }
    args.push('-t', String(visual.duration));
    args.push('-i', visual.source);
  }

  if (audioClip) {
    args.push('-ss', String(audioClip.in));
    args.push('-t', String(audioClip.duration));
    args.push('-i', audioClip.source);
  } else {
    args.push('-f', 'lavfi', '-t', String(duration), '-i', 'anullsrc=r=48000:cl=stereo');
  }

  if (bgm) {
    args.push('-ss', String(bgm.in));
    args.push('-t', String(bgm.duration));
    args.push('-i', bgm.source);
  }

  const segments: string[] = [];
  for (let i = 0; i < visualInputs.length; i++) {
    const visual = visualInputs[i];
    const effectiveScale =
      visual.fit === 'cover' ? Math.max(visual.scale, 1) : Math.min(visual.scale, 1);
    const targetW = Math.round(timeline.width * effectiveScale);
    const targetH = Math.round(timeline.height * effectiveScale);
    const scale = `scale=${targetW}:${targetH}:force_original_aspect_ratio=${visual.fit === 'cover' ? 'increase' : 'decrease'}`;
    const offsetX = visual.x ?? 0;
    const offsetY = visual.y ?? 0;
    const fitFilter =
      visual.fit === 'cover'
        ? `crop=${timeline.width}:${timeline.height}:(iw-${timeline.width})/2+${offsetX}:(ih-${timeline.height})/2+${offsetY}`
        : `pad=${timeline.width}:${timeline.height}:(ow-iw)/2+${offsetX}:(oh-ih)/2+${offsetY}:${bg}`;
    const label = `[s${i}]`;
    segments.push(
      `[${i}:v]${scale},${fitFilter},format=yuv420p,fps=${timeline.fps},setpts=PTS-STARTPTS,setsar=1${label}`,
    );
  }

  segments.push(...buildVisualChain(visualInputs, transitionDurations));

  let videoOutputLabel = 'v0';
  const cues = timeline.subtitles ?? [];
  if (cues.length > 0) {
    if (!subtitleFiles || subtitleFiles.length !== cues.length || !fontFiles || fontFiles.length !== cues.length) {
      throw new Error('Subtitle files or font missing for buildFfmpegCommand');
    }
    segments.push(buildSubtitleFilter(cues, subtitleFiles, fontFiles));
    videoOutputLabel = 'v';
  }

  const audioInputIndex = visualInputs.length;
  const aformat = 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo';
  let audioOutputLabel: string;
  if (bgm) {
    const needed = duration - bgm.start;
    segments.push(
      `[${audioInputIndex}:a]atrim=0:${duration},asetpts=PTS-STARTPTS,${aformat}[main]`,
    );
    segments.push(
      `[${audioInputIndex + 1}:a]atrim=0:${bgm.duration},asetpts=PTS-STARTPTS,aloop=loop=-1:size=${bgm.loopSamples},atrim=0:${needed},adelay=delays=${bgm.startSamples}S:all=1,volume=${bgm.volume},${aformat}[bgm]`,
    );
    segments.push(
      `[main][bgm]amix=inputs=2:duration=first:dropout_transition=0:normalize=0:weights='1 1'[aout]`,
    );
    audioOutputLabel = '[aout]';
  } else {
    audioOutputLabel = `${audioInputIndex}:a`;
  }

  args.push('-filter_complex', segments.join(';'));
  args.push('-map', `[${videoOutputLabel}]`);
  args.push('-map', audioOutputLabel);
  const presetName = resolveOutputPreset(timeline.outputPreset);
  args.push(...getEncodingArgs(presetName, timeline.fps));
  args.push('-t', String(duration));
  args.push('-movflags', '+faststart');
  args.push(resolvedOutput);

  return args;
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited with ${code}: ${stderr}`));
        return;
      }
      resolve();
    });
  });
}

async function getFfmpegVersion(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('ffmpeg', ['-version']);
    return stdout.split('\n')[0].trim();
  } catch (err) {
    return `unknown (${(err as Error).message})`;
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
          a.localeCompare(b),
        ),
      );
    }
    return v;
  });
}

export function timelineHash(timeline: Timeline): string {
  const hash = createHash('sha256');
  hash.update(canonicalJson(timeline));
  return hash.digest('hex');
}

export interface GenerateResult {
  args: string[];
  outputPath: string;
  probe: ProbeInfo;
  sourceHashes: Record<string, string>;
  timelineHash: string;
  outputSha256: string;
  ffmpegVersion: string;
  outputPreset: OutputPresetName;
  effectiveEncoding: EffectiveEncodingSettings;
  fontFile?: string;
  fontHash?: string;
  fontFamily?: string;
  timeline: Timeline;
}

export async function generate(
  input: unknown,
  options: { rootDir: string; fixturesDir: string; outputDir: string; fontsDir?: string },
): Promise<GenerateResult> {
  const fontsDir = options.fontsDir ?? join(options.rootDir, 'fonts');
  await mkdir(options.outputDir, { recursive: true });
  await mkdir(options.fixturesDir, { recursive: true });
  await mkdir(fontsDir, { recursive: true });

  const validated = await validateTimeline(input, { ...options, fontsDir });

  await mkdir(dirname(validated.resolvedOutput), { recursive: true });

  const inputSources: string[] = validated.visualInputs.map((v) => v.source);
  if (validated.audioClip) {
    inputSources.push(validated.audioClip.source);
  }
  if (validated.bgm) {
    inputSources.push(validated.bgm.source);
  }

  const sourceHashes: Record<string, string> = {};
  for (const source of new Set(inputSources)) {
    sourceHashes[source] = await sha256File(source);
  }
  if (validated.subtitleFonts) {
    for (const f of validated.subtitleFonts) {
      sourceHashes[f.fontFile] = f.fontHash;
    }
  }

  const ffmpegVersion = await getFfmpegVersion();
  const tHash = timelineHash(validated.timeline);

  let subtitleTempDir: string | undefined;
  let subtitleFiles: string[] | undefined;
  let fontFiles: string[] | undefined;

  try {
    if (validated.timeline.subtitles && validated.timeline.subtitles.length > 0) {
      subtitleTempDir = await prepareSubtitleWorkDir();
      fontFiles = validated.subtitleFonts!.map((f) => f.fontFile);
      subtitleFiles = await writeCueTextFiles(
        validated.timeline.subtitles,
        subtitleTempDir,
      );
    }

    const presetName = resolveOutputPreset(validated.timeline.outputPreset);
    const effectiveEncoding = getEffectiveEncoding(presetName);

    const args = buildFfmpegCommand(validated.timeline, {
      visualInputs: validated.visualInputs,
      audioClip: validated.audioClip,
      bgm: validated.bgm,
      duration: validated.duration,
      transitionDurations: validated.transitionDurations,
      resolvedOutput: validated.resolvedOutput,
      subtitleFiles,
      fontFiles,
    });

    await runFfmpeg(args);

    const probe = await ffprobe(validated.resolvedOutput);
    if (!probe.hasVideo || probe.videoCodec !== 'h264') {
      throw new UserError(
        'EXPECTED_H264_VIDEO',
        `Expected h264 video stream, got ${probe.videoCodec ?? 'none'}`,
        '動画の形式はh264である必要があります',
      );
    }
    if (!probe.hasAudio) {
      throw new Error('Expected audio stream');
    }
    if (probe.audioCodec !== 'aac') {
      throw new UserError(
        'EXPECTED_AAC_AUDIO',
        `Expected aac audio stream, got ${probe.audioCodec ?? 'none'}`,
        '音声の形式はaacである必要があります',
      );
    }
    if (probe.width !== validated.timeline.width || probe.height !== validated.timeline.height) {
      throw new Error(
        `Expected ${validated.timeline.width}x${validated.timeline.height}, got ${probe.width}x${probe.height}`,
      );
    }
    const frameTolerance = 1 / validated.timeline.fps + 0.001;
    if (Math.abs(probe.duration - validated.duration) > frameTolerance) {
      throw new UserError(
        'OUTPUT_DURATION_MISMATCH',
        `Duration mismatch: expected ${validated.duration}, got ${probe.duration}`,
        '生成された動画の長さが期待値と一致しません',
      );
    }

    for (const source of new Set(inputSources)) {
      const after = await sha256File(source);
      if (after !== sourceHashes[source]) {
        throw new UserError(
          'SOURCE_FILE_MODIFIED',
          `Source file was modified during generation: ${source}`,
          '生成中に素材ファイルが変更されました',
        );
      }
    }
    if (validated.subtitleFonts) {
      for (const f of validated.subtitleFonts) {
        const after = await sha256File(f.fontFile);
        if (after !== f.fontHash) {
          throw new UserError(
            'FONT_FILE_MODIFIED',
            `Font file was modified during generation: ${f.fontFile}`,
            '生成中にフォントファイルが変更されました',
          );
        }
      }
    }

    const outputSha256 = await sha256File(validated.resolvedOutput);

    return deepFreeze({
      args,
      outputPath: validated.resolvedOutput,
      probe,
      sourceHashes,
      timelineHash: tHash,
      outputSha256,
      ffmpegVersion,
      outputPreset: presetName,
      effectiveEncoding,
      fontFile: validated.font?.fontFile,
      fontHash: validated.font?.fontHash,
      fontFamily: validated.font?.fontFamily,
      timeline: validated.timeline,
    }) as GenerateResult;
  } finally {
    if (subtitleTempDir) {
      try {
        await rm(subtitleTempDir, { recursive: true, force: true });
      } catch (err) {
        console.error(
          `Warning: failed to remove subtitle temp dir ${subtitleTempDir}: ${(err as Error).message}`,
        );
      }
    }
  }
}
