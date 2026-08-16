import { z } from 'zod';

export const OUTPUT_PRESET_NAMES = ['preview', 'final'] as const;

export type OutputPresetName = (typeof OUTPUT_PRESET_NAMES)[number];

export const OutputPresetSchema = z.enum(['preview', 'final']).optional();

export interface EffectiveEncodingSettings {
  readonly outputPreset: OutputPresetName;
  readonly videoCodec: string;
  readonly x264Preset: string;
  readonly crf: number;
  readonly pixelFormat: string;
  readonly audioCodec: string;
  readonly audioBitrate: string;
}

interface PresetDefinition {
  readonly videoCodec: string;
  readonly x264Preset: string;
  readonly crf: number;
  readonly pixelFormat: string;
  readonly audioCodec: string;
  readonly audioBitrate: string;
}

const PREVIEW_PRESET: PresetDefinition = Object.freeze({
  videoCodec: 'libx264',
  x264Preset: 'fast',
  crf: 23,
  pixelFormat: 'yuv420p',
  audioCodec: 'aac',
  audioBitrate: '128k',
});

const FINAL_PRESET: PresetDefinition = Object.freeze({
  videoCodec: 'libx264',
  x264Preset: 'medium',
  crf: 18,
  pixelFormat: 'yuv420p',
  audioCodec: 'aac',
  audioBitrate: '192k',
});

export const OUTPUT_PRESETS: Readonly<
  Record<OutputPresetName, Readonly<PresetDefinition>>
> = Object.freeze({
  preview: PREVIEW_PRESET,
  final: FINAL_PRESET,
});

export const DEFAULT_OUTPUT_PRESET: OutputPresetName = 'preview';

export function resolveOutputPreset(value: unknown): OutputPresetName {
  if (value === undefined || value === null) {
    return DEFAULT_OUTPUT_PRESET;
  }
  if (typeof value !== 'string') {
    throw new Error(`outputPreset must be a string, got ${typeof value}`);
  }
  if (!OUTPUT_PRESET_NAMES.includes(value as OutputPresetName)) {
    throw new Error(
      `Unknown output preset: ${value}. Allowed: ${OUTPUT_PRESET_NAMES.join(', ')}`,
    );
  }
  return value as OutputPresetName;
}

export function getEncodingArgs(
  presetName: OutputPresetName,
  fps: number,
): string[] {
  const preset = OUTPUT_PRESETS[presetName];
  return [
    '-c:v',
    preset.videoCodec,
    '-r',
    String(fps),
    '-preset',
    preset.x264Preset,
    '-crf',
    String(preset.crf),
    '-pix_fmt',
    preset.pixelFormat,
    '-c:a',
    preset.audioCodec,
    '-b:a',
    preset.audioBitrate,
  ];
}

export function getEffectiveEncoding(
  presetName: OutputPresetName,
): EffectiveEncodingSettings {
  const preset = OUTPUT_PRESETS[presetName];
  return Object.freeze({
    outputPreset: presetName,
    videoCodec: preset.videoCodec,
    x264Preset: preset.x264Preset,
    crf: preset.crf,
    pixelFormat: preset.pixelFormat,
    audioCodec: preset.audioCodec,
    audioBitrate: preset.audioBitrate,
  });
}
