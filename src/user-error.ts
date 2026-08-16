export function toUserMessage(err: unknown): string {
  if (err instanceof Error) {
    const m = err.message;

    // よくある英語の内部エラーを日本語にマッピングする
    if (m.includes('Multiple audio clips')) return '音声クリップは1つまでです';
    if (m.includes('Transition count mismatch')) return 'トランジション数がクリップ数と合いません';
    if (m.includes('at most 5 visual clips')) return '画像・動画は最大5つまでです';
    if (m.includes('Timeline must contain at least one image or video clip')) {
      return 'タイムラインには画像か動画のクリップが1つ以上必要です';
    }

    if (m.includes('has invalid duration (start >= end)') || m.includes('has invalid in/out (in >= out)')) {
      return 'クリップの開始・終了位置が不正です';
    }
    if (m.includes('in/out range must match timeline duration')) return 'クリップのトリム範囲と長さが一致しません';
    if (m.includes('First visual clip start must be 0')) return '最初のクリップは開始位置0秒からにしてください';
    if (m.includes('Audio start must be 0')) return '音声は開始位置0秒からにしてください';
    if (m.includes('Audio clip out') && m.includes('exceeds source duration')) {
      return '主音声の終了位置が素材の長さを超えています';
    }

    if (m.includes('Could not determine audio peak')) return '音声ピークを検出できませんでした';

    if (m.includes('BGM source must contain an audio stream')) return 'BGMファイルに音声ストリームがありません';
    if (m.includes('BGM source has no usable duration')) return 'BGMファイルの長さを取得できません';
    if (m.includes('BGM source has no usable sample rate')) return 'BGMファイルのサンプリングレートが取得できません';
    if (m.includes('BGM mix would exceed full scale')) return 'BGM音量が大きすぎます';

    if (m.includes('Expected h264 video stream')) return '動画の形式はh264である必要があります';
    if (m.includes('Expected aac audio stream')) return '音声の形式はaacである必要があります';
    if (m.includes('Duration mismatch')) return '生成された動画の長さが期待値と一致しません';
    if (m.includes('Source file was modified during generation')) return '生成中に素材ファイルが変更されました';
    if (m.includes('Font file was modified during generation')) return '生成中にフォントファイルが変更されました';

    if (m.includes('Too many subtitle cues')) return '字幕の数が多すぎます';
    if (m.includes('Subtitle cue start') && m.includes('must be less than end')) {
      return '字幕の開始時間は終了時間より前である必要があります';
    }
    if (m.includes('Subtitle cue start') && m.includes('exceeds video duration')) {
      return '字幕の開始時間が動画の長さを超えています';
    }
    if (m.includes('Subtitle cue end') && m.includes('exceeds video duration')) {
      return '字幕の終了時間が動画の長さを超えています';
    }
    if (m.includes('Font path is not a regular file')) return 'フォントファイルが見つかりません';
    if (m.includes('Font hash mismatch')) return 'フォントファイルの内容が変更されました';
    if (m.includes('Failed to query font glyph coverage')) return 'フォントで使える文字を確認できませんでした';

    // 既に日本語のメッセージはそのまま返す
    if (/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/.test(m)) return m;

    // 特定の英語キーワードを含む場合はカテゴリを先頭に付ける
    if (m.includes('font') || m.includes('Font')) return `フォントエラー: ${m}`;
    if (m.includes('ffmpeg exited')) return `FFmpegでエラーが発生しました: ${m}`;
    if (m.includes('exceeds source duration')) return `指定範囲が素材の長さを超えています: ${m}`;
    if (m.includes('request body too large') || m.includes('Content-Length exceeded')) return 'リクエストサイズが大きすぎます';

    return `エラー: ${m}`;
  }
  return `エラー: ${String(err)}`;
}
