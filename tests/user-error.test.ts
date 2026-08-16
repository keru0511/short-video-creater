import { describe, expect, it } from 'vitest';
import { toUserMessage } from '../src/user-error.js';

describe('toUserMessage', () => {
  it('maps known English core errors to Japanese', () => {
    expect(toUserMessage(new Error('Timeline must contain at least one image or video clip'))).toBe(
      'タイムラインには画像か動画のクリップが1つ以上必要です',
    );
    expect(toUserMessage(new Error('Clip video.mp4 has invalid duration (start >= end)'))).toBe(
      'クリップの開始・終了位置が不正です',
    );
    expect(toUserMessage(new Error('Audio clip out (10) exceeds source duration (5)'))).toBe(
      '主音声の終了位置が素材の長さを超えています',
    );
  });

  it('maps known English subtitle errors to Japanese', () => {
    expect(toUserMessage(new Error('Too many subtitle cues: 100 (max 50)'))).toBe('字幕の数が多すぎます');
    expect(
      toUserMessage(new Error('Subtitle cue start (3) must be less than end (2)')),
    ).toBe('字幕の開始時間は終了時間より前である必要があります');
    expect(toUserMessage(new Error('Subtitle cue end (10) exceeds video duration (5)'))).toBe(
      '字幕の終了時間が動画の長さを超えています',
    );
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
