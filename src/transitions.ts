import { z } from 'zod';
import type { VisualInput } from './core.js';

// Per-transition absolute upper bound for this slice.
export const MAX_TRANSITION_DURATION_SECONDS = 2;

export const TransitionSchema = z.object({
  type: z.literal('crossfade').default('crossfade'),
  duration: z.number().finite().positive().max(MAX_TRANSITION_DURATION_SECONDS),
});

export type Transition = z.infer<typeof TransitionSchema>;

export interface ValidatedVisualClip {
  source: string;
  duration: number;
}

export interface TransitionValidationResult {
  totalDuration: number;
  effectiveDurations: number[];
}

export function quantizeTransitionDuration(duration: number, fps: number): number {
  const frames = Math.round(duration * fps);
  return frames / fps;
}

export function transitionFrames(duration: number, fps: number): number {
  return Math.round(duration * fps);
}

export function validateTransitions(
  transitions: Transition[] | undefined,
  visualClips: ValidatedVisualClip[],
  fps: number,
): TransitionValidationResult {
  if (!transitions || transitions.length === 0) {
    return { totalDuration: 0, effectiveDurations: [] };
  }

  const expected = visualClips.length - 1;
  if (transitions.length !== expected) {
    throw new Error(
      `Transition count mismatch: expected ${expected} for ${visualClips.length} visual clips, got ${transitions.length}`,
    );
  }

  const effectiveDurations: number[] = [];
  let total = 0;

  for (let i = 0; i < transitions.length; i++) {
    const transition = transitions[i];
    if (transition.type !== 'crossfade') {
      throw new Error(`Unsupported transition type: ${transition.type}`);
    }

    const d = transition.duration;
    if (!Number.isFinite(d) || Number.isNaN(d) || d <= 0) {
      throw new Error(`Transition ${i} duration must be finite and positive`);
    }
    if (d > MAX_TRANSITION_DURATION_SECONDS + 0.001) {
      throw new Error(
        `Transition ${i} duration ${d} exceeds maximum ${MAX_TRANSITION_DURATION_SECONDS}`,
      );
    }

    const frames = transitionFrames(d, fps);
    if (frames < 1) {
      throw new Error(
        `Transition ${i} duration ${d} is less than one frame at ${fps}fps`,
      );
    }
    const effective = frames / fps;

    const prev = visualClips[i];
    const next = visualClips[i + 1];
    if (effective > prev.duration + 0.001) {
      throw new Error(
        `Transition ${i} effective duration ${effective} exceeds previous clip duration ${prev.duration}`,
      );
    }
    if (effective > next.duration + 0.001) {
      throw new Error(
        `Transition ${i} effective duration ${effective} exceeds next clip duration ${next.duration}`,
      );
    }

    if (i > 0) {
      const prevEffective = effectiveDurations[i - 1];
      if (prevEffective + effective > visualClips[i].duration + 0.001) {
        throw new Error(
          `Transitions ${i - 1} and ${i} overlap in clip ${i} ` +
          `(${prevEffective.toFixed(4)} + ${effective.toFixed(4)} > ${visualClips[i].duration})`,
        );
      }
    }

    effectiveDurations.push(effective);
    total += effective;
  }

  return { totalDuration: total, effectiveDurations };
}

// Builds the filter_complex segment that combines scaled visual inputs into a
// single [v0] stream. With transitions, an xfade chain is used; otherwise a
// concat filter is used when there are multiple inputs.
export function buildVisualChain(
  visualInputs: VisualInput[],
  effectiveDurations: number[],
): string[] {
  if (visualInputs.length === 1) {
    return ['[s0]copy[v0]'];
  }

  if (effectiveDurations.length === 0) {
    const inputs = visualInputs.map((_, i) => `[s${i}]`).join('');
    return [`${inputs}concat=n=${visualInputs.length}:v=1:a=0[v0]`];
  }

  const segments: string[] = [];
  let currentLabel = '[s0]';
  let currentDuration = visualInputs[0].duration;

  for (let i = 0; i < effectiveDurations.length; i++) {
    const t = effectiveDurations[i];
    const isLast = i === effectiveDurations.length - 1;
    const outputLabel = isLast ? '[v0]' : `[x${i}]`;
    const offset = currentDuration - t;
    const nextInput = `[s${i + 1}]`;
    segments.push(
      `${currentLabel}${nextInput}xfade=transition=fade:duration=${t}:offset=${offset}${outputLabel}`,
    );
    currentDuration = offset + visualInputs[i + 1].duration;
    currentLabel = outputLabel;
  }

  return segments;
}
