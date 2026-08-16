import { describe, expect, it } from 'vitest';
import { toUserMessage, UserError } from '../src/user-error.js';

describe('toUserMessage', () => {
  it('maps known structured core errors to Japanese', () => {
    expect(
      toUserMessage(
        new UserError(
          'TIMELINE_MISSING_VISUAL_CLIP',
          'Timeline must contain at least one image or video clip',
          'タイムラインには画像か動画のクリップが1つ以上必要です',
        ),
      ),
    ).toBe('タイムラインには画像か動画のクリップが1つ以上必要です');

    expect(
      toUserMessage(
        new UserError(
          'CLIP_INVALID_DURATION',
          'Clip video.mp4 has invalid duration (start >= end)',
          'クリップの開始・終了位置が不正です',
        ),
      ),
    ).toBe('クリップの開始・終了位置が不正です');

    expect(
      toUserMessage(
        new UserError(
          'AUDIO_CLIP_EXCEEDS_SOURCE',
          'Audio clip out (10) exceeds source duration (5)',
          '主音声の終了位置が素材の長さを超えています',
        ),
      ),
    ).toBe('主音声の終了位置が素材の長さを超えています');
  });

  it('maps known structured subtitle errors to Japanese', () => {
    expect(
      toUserMessage(
        new UserError(
          'TOO_MANY_SUBTITLE_CUES',
          'Too many subtitle cues: 100 (max 50)',
          '字幕の数が多すぎます',
        ),
      ),
    ).toBe('字幕の数が多すぎます');

    expect(
      toUserMessage(
        new UserError(
          'SUBTITLE_CUE_START_AFTER_END',
          'Subtitle cue start (3) must be less than end (2)',
          '字幕の開始時間は終了時間より前である必要があります',
        ),
      ),
    ).toBe('字幕の開始時間は終了時間より前である必要があります');

    expect(
      toUserMessage(
        new UserError(
          'SUBTITLE_CUE_END_EXCEEDS_VIDEO',
          'Subtitle cue end (10) exceeds video duration (5)',
          '字幕の終了時間が動画の長さを超えています',
        ),
      ),
    ).toBe('字幕の終了時間が動画の長さを超えています');
  });

  it('preserves messages that already contain Japanese', () => {
    expect(toUserMessage(new Error('フォントが見つかりません'))).toBe('フォントが見つかりません');
    expect(toUserMessage(new Error('クリップ 1 の素材が見つかりません: abc123'))).toBe(
      'クリップ 1 の素材が見つかりません: abc123',
    );
  });

  it('prefixes unknown English errors with エラー', () => {
    expect(toUserMessage(new Error('something unexpected'))).toBe('エラー: something unexpected');
  });
});
