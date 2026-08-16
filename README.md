# short-video-creater

Node.js/TypeScript コアで、fixture から 9:16 の MP4 を生成します。

## 必要条件

- [mise](https://mise.jdx.dev/)（推奨）または Node.js 20.x + npm 10.8.x
- FFmpeg 4.x+（libx264 / aac / drawtext フィルター付き）

## セットアップ

```bash
mise install
npm ci
```

mise を使わない場合は Node.js 20.x と npm 10.8.x を用意し、以下を実行してください。

```bash
npm ci
```

## GUI で MP4 生成

初回セットアップ後は、OSに合った起動スクリプトをダブルクリックするだけでブラウザが開きます。`node_modules` が存在しない場合、ランチャーが `npm ci` を自動で実行します。

| OS | 起動ファイル |
|----|-------------|
| Linux | `launch-gui.sh` |
| macOS | `launch-gui.command` |
| Windows | `launch-gui.bat` |

またはターミナルから：

```bash
npm run gui:launch
```

ブラウザが自動的に起動した GUI の URL を開きます。`GUI_PORT` を指定しない場合は空きポートを自動選択するため、他のアプリや既存 GUI が 3000 番を使っていても起動できます。固定したい場合は `GUI_PORT` 環境変数でポートを指定してください（例: `GUI_PORT=3000 npm run gui:launch`）。素材をドラッグ＆ドロップ・字幕・BGM・クロスフェード・preview/final を設定して「動画を生成」を押します。生成された MP4 は同一画面で再生でき、出力フォルダを開けます。

### プロジェクトベースのタイムライン編集

GUI 上部でプロジェクト ID を選び、素材をアップロードすると素材ライブラリに追加されます。タイムラインでクリップを並び替えたり、各クリップの `in`/`out`・`fit`（cover / contain）を調整したり、クリップを分割・複製・削除できます。主音声・BGM・字幕も同じ画面で設定でき、トランスクリプト JSON を貼り付けて字幕を自動生成することもできます。設定は `gui/projects/<projectId>/timeline.json` に保存されるため、ブラウザを閉じても作業を再開できます。

### Codex App Server 連携

OpenAI Codex や他の MCP クライアントから操作するための MCP サーバーを同梱しています。リポジトリルートで以下を実行するか、`~/.codex/config.toml` や `.codex/config.toml` にサーバーを登録してください。

```bash
npm run mcp-server
```

登録後は Codex から `upload_media`、`add_clip`、`set_clip_range`、`split_clip`、`add_subtitle`、`import_transcript`、`export_video` などのツールを呼び、会話の中で動画の読み込み・範囲選択・カット・字幕挿入・書き出しを進めることができます。

#### セキュリティに関する注意

MCP サーバーは起動したローカルユーザー権限で動作し、`upload_media` では指定されたファイルパスを読み込みます。ファイルパスはリポジトリルートからの相対パス、または絶対パスとして解決されます。信頼できない MCP クライアントやプロンプトに接続しないでください。`npm run mcp-server` を実行する端末では、機密ファイルが読み込まれないよう注意してください。

### フォントについて

字幕を使わない場合は `fonts/` が空でも GUI を起動・動画生成できます。字幕を使う場合は、事前に `npm run setup:fonts` を実行するか、`fonts/` に単一 face の `.ttf` / `.otf` フォントを配置してください。

- Linux: `npm run setup:fonts` でシステムにインストールされた DejaVu Sans / IPAGothic を `fonts/` へコピーします。
- macOS / Windows: システムフォントのコピーは行わないため、`.ttf` / `.otf` フォントを `fonts/` に手動で配置してください。配置しないまま字幕付き動画を生成しようとすると、GUI 上にフォント準備のエラーメッセージが表示されます。

## 1 コマンドで MP4 生成

```bash
mise run generate
```

生成結果は `output/video.mp4` に出力されます。

## 明示 sub-range からの MP4 生成

同一動画の `[0, 2.5]` と `[2.5, 5]` のような明示的な sub-range を v2 `MediaSegmentManifest` として扱い、字幕付き MP4 を生成する最小パスです。

```bash
npm run generate:fixtures
npm run setup:fonts

# 1. catalog を生成
npx tsx src/catalog-cli.ts fixtures output/catalog.json

# 2. sub-range request を作成し、v2 manifest を生成
npx tsx src/media-subranges-cli.ts \
  fixtures/media-subrange-input/subranges.json \
  output/catalog.json \
  fixtures \
  output/media-subranges/manifest.json

# 3. selection + transcript source で transcript manifest を生成
npx tsx src/transcript-manifest-cli.ts \
  output/media-subranges/manifest.json \
  fixtures/media-subrange-input/transcript-source.json \
  fixtures \
  output/transcripts/manifest.json

# 4. selection + transcript manifest + style で字幕付き timeline を生成
npx tsx src/transcript-subtitle-timeline-cli.ts \
  output/media-subranges/manifest.json \
  fixtures/media-subrange-input/selection.json \
  output/transcripts/manifest.json \
  fixtures/media-subrange-input/style.json \
  fixtures \
  output/timelines/subranges.json

# 5. timeline を renderer へ渡して MP4 生成
npx tsx src/cli.ts output/timelines/subranges.json
```

- `npm run generate:fixtures` は `fixtures/media-subrange-input/subranges.json`、`fixtures/media-subrange-input/transcript-source.json`、`fixtures/media-subrange-input/selection.json`、`fixtures/media-subrange-input/style.json` が repository に tracked された canonical files として存在し、`fixtures/black.mp4` および `fonts/DejaVuSans.ttf` のハッシュ・segment ID と一致することを検証します。
- `fixtures/media-subrange-input/subranges.json` は `v1` の range request（同一ファイルの `[0, 2.5]` と `[2.5, 5]` を含む）。
- `output/media-subranges/manifest.json` は `v2` の `MediaSegmentManifest`。
- `fixtures/media-subrange-input/selection.json` は使用する `segmentId` のリスト。
- 各 CLI は入力ファイルを input snapshot として記録し、出力は atomic no-replace で書き込みます。

詳細は `docs/media-subranges.md` を参照してください。

## CI 実行

```bash
mise run ci
```

または

```bash
actrun lint .github/workflows/ci.yml
actrun workflow run .github/workflows/ci.yml --dry-run
actrun workflow run .github/workflows/ci.yml
```

## 手動実行

```bash
npm install
npm run generate:fixtures
npm run generate:video -- fixtures/timeline.json
npm run generate:video -- fixtures/subtitles.json
npm run verify
npm test
```

## 副作用アクションの明示承認 gate

副作用アクション（`publish` / `delete` / `external-send`）に対する承認 gate は `src/approval.ts` / `src/approval-cli.ts` で提供されます。gate は実際の公開・削除・外部送信は実行せず、Request と Receipt を検証して decision レコードを `output/approvals/<requestSha256>.json` に atomically に書き込みます。詳細は `docs/approval.md` を参照してください。

```bash
npx tsx src/approval-cli.ts --project-root . --request requests/publish.json --receipt receipts/publish.json --now 2026-07-31T12:00:00Z
```

## 公開前 release readiness 検証

`publish` APPROVED decision と generation audit manifest、最終 9:16 MP4 の整合を検証し、公開前に `ready=true` の決定論的レポートを `output/readiness/` へ atomic no-replace で書き込みます。実際の公開・削除・外部送信は行いません。

`npm run generate:fixtures` で素材を準備し、`npm run generate:video -- fixtures/<timeline>.json` で 9:16 MP4 と audit manifest を生成後、`src/approval-cli.ts` または fixture decision 生成で `publish` APPROVED decision を作り、以下のように検証できます。`--now` は RFC 3339 / ISO 8601 UTC 形式で固定すると、レポートの `reportSha256` が再現可能です。

```bash
npx tsx src/release-readiness-cli.ts \
  --project-root . \
  --mp4 output/video.mp4 \
  --audit output/audit/<jobId>.json \
  --decision output/approvals/<requestSha256>.json \
  --now 2026-07-31T12:00:00.000Z \
  --output-rel readiness/report-timeline.json
```

詳細、ffprobe 結果、SHA-256、入力不変の証拠は下記「release-readiness E2E 証拠」を参照してください。

## 字幕（subtitle cue）

`timeline.json` / `subtitles.json` のように、`subtitles` 配列を追加すると、指定時刻にテロップを 9:16 動画へ焼き込みます。

各 cue は `start`、`end`、`text`、`x`、`y`、`fontSize` を持ちます。`text` はテキストファイル経由で FFmpeg `drawtext` へ渡されるため、シェルやフィルター構文を破る特殊文字が含まれても安全に処理されます。

字幕付きタイムラインでは `font`（`fonts/` 内の相対パス）とそのファイルの SHA-256 を `fontHash` で指定してください。使用できるのは単一 face の `.ttf` / `.otf` のみで、`.ttc` / `.otc` などのコレクションフォントはこの縦切りでは扱いません。これにより、同じタイムラインが同じ font face で決定論的にレンダリングされます。`fontHash` が実際のファイルと一致しない場合、レンダリング前に拒否されます。

許可される制御文字は LF (`\n`)、CR (`\r`)、TAB (`\t`) のみで、これらはレイアウト制御として扱われます。それ以外の制御文字は拒否されます。

```json
{
  "width": 1080,
  "height": 1920,
  "fps": 30,
  "outputPath": "subtitled.mp4",
  "background": "000000",
  "font": "DejaVuSans.ttf",
  "fontHash": "690243adfefe0ce154b547db6205794bd30ac4277275179517a90994f4980648",
  "clips": [...],
  "subtitles": [
    { "start": 0.5, "end": 1.0, "text": "Hello", "x": 540, "y": 1500, "fontSize": 100 },
    { "start": 1.5, "end": 2.0, "text": "World", "x": 540, "y": 1500, "fontSize": 100 }
  ]
}
```

`fonts/` ディレクトリは `.gitkeep` で維持されます。`npm run setup:fonts`（Linux）または手動配置で `.ttf` / `.otf` フォントを `fonts/` に入れてください。`npm run generate:fixtures` も内部でフォントを準備しますが、GUI 起動時には `setup:fonts` 以外の fixture 生成を行いません。独自のフォントを使う場合は単一 face の `.ttf` / `.otf` を `fonts/` に配置し、`sha256sum fonts/YourFont.ttf` で得たハッシュを `fontHash` に記入してください。

生成結果には `timelineHash`、`FFmpeg version`、`fontFile`、`fontFamily`、`fontHash`、サニタイズ済み `argv`、ソース素材の SHA-256 が含まれ、再現性の証拠として利用できます。

## BGM ミックス（BGM track）

`bgm` フィールドを追加すると、既存の主音声を維持したまま単一の BGM をミックスできます。

```json
{
  "width": 1080,
  "height": 1920,
  "fps": 30,
  "outputPath": "with-bgm.mp4",
  "background": "000000",
  "clips": [
    { "type": "image", "source": "black.png", "start": 0, "end": 5, "in": 0, "out": 5, "fit": "cover" },
    { "type": "audio", "source": "audio-440.wav", "start": 0, "end": 5, "in": 0, "out": 5 }
  ],
  "bgm": {
    "source": "bgm-880.wav",
    "start": 0,
    "in": 0,
    "out": 2,
    "volume": 0.5
  }
}
```

BGM は `fixtures/` 内の相対パスで指定します。`start` は動画上の開始時刻、`in`/`out` は BGM 素材のトリム範囲、`volume` は 0 から 1 の範囲です。BGM 素材が動画総尺より短い場合、トリム後の区間を決定論的にループして最後まで埋めます。BGM なしタイムラインとの互換性は維持されます。

`fixtures/bgm.json` に BGM ミックスのサンプルがあります。

## 出力プリセット（outputPreset）

タイムラインに `outputPreset` を追加すると、エンコード品質を用途別に固定できます。未指定時は `preview` と同じ設定が使用され、既存の動作と完全に互換です。

```json
{
  "width": 1080,
  "height": 1920,
  "fps": 30,
  "outputPath": "final.mp4",
  "outputPreset": "final",
  "background": "000000",
  "clips": [...]
}
```

| プリセット | 映像 codec | x264 preset | CRF | pixel format | 音声 codec | 音声 bitrate |
|-----------|-----------|-------------|-----|--------------|-----------|-------------|
| `preview` | libx264   | fast        | 23  | yuv420p      | aac       | 128k        |
| `final`   | libx264   | medium      | 18  | yuv420p      | aac       | 192k        |

`preview` / `final` 以外の値や型不正、任意の FFmpeg option 文字列はエンコード開始前に拒否されます。

## トランジション（crossfade）

`transitions` 配列を追加すると、隣接する visual clip 間にクロスフェードを入れられます。現時点では `crossfade` のみ対応しています。

各 transition は `duration`（秒）を持ち、指定された timeline `fps` の frame grid に丸められます。1 frame 未満に丸まる duration は拒否されます。丸め後の effective duration を使って前後 clip 尺超過、overlap、総尺、FFmpeg `xfade` の duration/offset が共通で計算されます。

```json
{
  "width": 1080,
  "height": 1920,
  "fps": 30,
  "outputPath": "transitions.mp4",
  "background": "000000",
  "clips": [
    { "type": "image", "source": "red.png", "start": 0, "end": 2, "in": 0, "out": 2, "fit": "cover" },
    { "type": "video", "source": "blue.mp4", "start": 2, "end": 4, "in": 0, "out": 2, "fit": "cover" },
    { "type": "image", "source": "black.png", "start": 4, "end": 6, "in": 0, "out": 2, "fit": "cover" },
    { "type": "audio", "source": "audio.mp3", "start": 0, "end": 5, "in": 0, "out": 5 }
  ],
  "transitions": [
    { "type": "crossfade", "duration": 0.5 },
    { "type": "crossfade", "duration": 0.5 }
  ]
}
```

`fixtures/transitions.json` にサンプルがあります。

## 統合 E2E パイプライン

`fixtures/pipeline-e2e.json` は、複数 visual clip（image / video 混在）、2 つの crossfade、2 つ以上の字幕 cue、主音声、単一 BGM、および `final` 出力プリセットを 1 本の timeline に統合した E2E fixture です。クリーン環境から、以下の 1 コマンドで統合 9:16 MP4 を生成できます。

```bash
npm run generate:fixtures && npm run generate:video -- fixtures/pipeline-e2e.json
```

生成された MP4 は `output/pipeline-e2e.mp4` に出力されます（実体は `output/artifacts/<jobId>/pipeline-e2e.mp4` で、同一内容が `output/pipeline-e2e.mp4` へコピーされます）。

### 9:16 MP4 検証証拠

`mise run generate`（`fixtures/timeline.json` → `output/video.mp4`）:

- SHA-256: `f221383139fb885ac598b89cbf987ae75bdcb7b2050ba8d33eb8cdf01de0bd90`
- ffprobe:
  - width: 1080
  - height: 1920
  - fps: 30
  - video codec: h264
  - audio codec: aac
  - sample rate: 44100
  - duration: 5

実際の生成結果例（`output/pipeline-e2e.mp4`）:

- SHA-256: `4cd908b4cb925c55bffe5671fedb86ecf3b928d315a767bca70438ae4ee042f7`
- ffprobe:
  - width: 1080
  - height: 1920
  - fps: 30
  - video codec: h264
  - audio codec: aac
  - sample rate: 48000
  - duration: 5

字幕付き 9:16 MP4（`fixtures/subtitles.json` → `output/subtitled.mp4`）:

- SHA-256: `3cf07a0f93dfe750c5c7f78904cf377f1f7566a767b035d99ebca4b2357eb6d5`
- ffprobe:
  - width: 1080
  - height: 1920
  - fps: 30
  - video codec: h264
  - audio codec: aac
  - sample rate: 44100
  - duration: 3

字幕付き Timeline からの 9:16 MP4（`output/timelines/subtitled.json` → `output/timelines/subtitled.mp4`）:

- Timeline JSON SHA-256: `5e16db44eb243a445da2fc65ab5de3847b8284df188bc1d1cfdc03e06af76592`
- MP4 SHA-256: `0b4d8fba48b52723cf32323e3d694749ab93e114b396b7061482a2d98ca9942d`
- ffprobe:
  - width: 1080
  - height: 1920
  - fps: 30
  - video codec: h264
  - audio codec: aac
  - sample rate: 48000
  - duration: 5

multi-clip 字幕付き Timeline からの 9:16 MP4（`output/timelines/subtitled-multi.json` → `output/timelines/subtitled-multi.mp4`）:

- Timeline JSON SHA-256: `f2960eb7bb3c1fd6d2d91c360ff38d742d6167ddad9e31fd462d8219097ef284`
- MP4 SHA-256: `07fe4fb7939fbabf24668bfb5f1cd25075a99c48a811c3173e8aad5ad1fc739b`
- ffprobe:
  - width: 1080
  - height: 1920
  - fps: 30
  - video codec: h264
  - audio codec: aac
  - sample rate: 48000
  - duration: 10

`npm run generate:fixtures && npm run generate:video -- fixtures/pipeline-e2e.json` および `npm run generate:video -- fixtures/subtitles.json` を実行した前後で、`fixtures/` および `fonts/` 内の全ファイル SHA-256 は変化していません（`diff` 差分なし）。`output/timelines/subtitled.json` と `output/timelines/subtitled-multi.json` も再実行で同じ SHA-256 になります。

### 実行方法

検証は専用の E2E テストで実行します。

```bash
npx vitest run tests/pipeline-e2e.test.ts --no-file-parallelism
# または
npm test
```

`tests/pipeline-e2e.test.ts` では、ffprobe による解像度・fps・尺・H.264/AAC/音声 stream の検証、transition 前/途中/後のフレーム検証、字幕表示中/表示外のフレーム検証、PCM 解析による主音声 440Hz と BGM 880Hz の両成分検証、`final` preset による FFmpeg argv の固定設定検証、入力素材 SHA-256 の不変確認、および同一環境での連続 2 回生成の再現性確認を行います。

## Media catalog thumbnails（素材カタログサムネイル）

素材カタログは画像・動画アセットから決定論的な JPG サムネイルを生成できます。詳細な設計と安全保証は `docs/media-catalog.md` を参照してください。

### カタログ再スキャン差分

前回生成したカタログと再スキャン結果を比較し、追加・変更・削除・不変・移動候補を決定論的に出力できます。

```bash
npx tsx src/catalog-cli.ts diff <previous-catalog.json> <input-dir> <output-relative.json>
```

- `unchanged`: パスと content SHA-256 が同じ
- `changed`: パスは同じだが content SHA-256 が変わった
- `moved`: content SHA-256 が同じでパスが変わった
- `added` / `removed`: 新規・削除されたパス

前回カタログの絶対パス、`..` 含む相対パス、重複パス、型不正、過大入力は fail-closed で拒否します。出力は `output/` 配下へ atomic write されます。

### サムネイル検証証拠

`npx tsx src/catalog-cli.ts fixtures output/catalog.json` を実行します。exact-head に対する実行結果（`output/catalog.json` SHA-256、`mise run ci` の `run_id` など）は PR #12 説明欄に記載します。

- catalog assets: 22
- thumbnails: 8
- 全サムネイル codec: `mjpeg`、width/height: 270x480（`maxDimension=480` でアスペクト比維持）
- 全 `thumbnail.sha256` が実ファイルの SHA-256 と一致
- 全サムネイルファイル mode: `0o100400`（owner read-only；new write-open は `EACCES`）
- サムネイルファイル名・内容は決定論的；`catalog.json` は各 asset の `mtime` を含むため fixture 再生成で SHA が変動する
- 大容量 sparse 入力（`MAX_SOURCE_BYTES` 超過）は fail-closed で OOM なし
- non-faststart MP4 も `-i - -ss <time>` 出力 seeking で決定論的サムネイルを生成
- 入力境界は `inputRoot` に限定され、`projectRoot` 外の正当なローカル素材フォルダも扱える（catalog-cli E2E）
- source fstat 後の append/growth/inode 改竄は small-buffer 経路・streaming 経路の両方で EOF + re-stat（size / mtime / dev / ino）で検出
- `src/catalog-cli.ts` は `writeCatalog` 前に `verifyThumbnail(projectRoot, info)` で各サムネイルの SHA-256・パス境界を再検証（pre-write consistency check）
- `0o400` / read-only 属性と `verifyThumbnail` は協調的な並行 process／使用時の整合性チェック向けであり、同一ユーザー敵対 process が path を差し替える攻撃に対する immutable 境界ではない。同ユーザー敵対を防ぐには別 OS identity、immutable storage、または消費時の再検証が必要
- Windows 等 fd-relative path 非対応環境では、pathname race による ancestor symlink/junction 差し替えを完全に排除できないため、同ユーザー敵対契約は別 OS identity または immutable storage が前提（`docs/media-catalog.md` 参照）
- publish 失敗時は共有 content-addressed final path を `unlink` しない。失敗 cleanup は自プロセスの temp file のみを削除し、`lstat`/`unlink` TOCTOU を回避
- FFmpeg が非 0 で早期終了した場合、pump を即座に停止し、大容量破損入力を最後まで読み込んで hash することがない
- 追加敵対的テスト：
  - source fstat 後の append/growth を small-buffer 経路・streaming 経路の両方で検出
  - source re-stat 後の `size`/`mtime`/`dev`/`ino` 不一致を検出
  - temp 作成時点からの第三者 write-open 不可（`0o400` mode from creation、`EACCES`）
  - publish 直前の thumbnailDir ancestor 移動・symlink 差し替えを fd-relative 非対応環境でも fail-closed
  - Windows フォールバック時の ancestor 差し替え後の境界外ファイル/ディレクトリ生成を防止・クリーンアップ
  - 同一 inode 改竄、final の read-only 化、EEXIST 失敗時の共有 final 非破壊、`afterFinalOpen`/`afterFinalHash` barrier
  - linked publish 失敗時に正常な共有 final が `lstat`/`unlink` ウィンドウで誤削除されないことの barrier テスト
  - `verifyThumbnail` の bounded 読み込み（50 MiB cap、OOM 回避）と path 差し替え検出（read 中・read 直後の fd/path `dev`/`ino`/`size` 再確認）
  - stdout/stderr 上限超過時の fail-closed・規定時間内 settle
  - ffmpeg 非 0 早期終了時の bounded 読込・即時 settle・final なし
- 生成前後で `fixtures/` / `fonts/` 内の全ファイル SHA-256 は変化なし

### 9:16 MP4 検証と release-readiness プロトコル

`npm run generate:fixtures && npm run generate:video -- fixtures/<route>.json` を `fixtures/timeline.json`、`fixtures/subtitles.json`、`fixtures/pipeline-e2e.json` の 3 経路で実行し、生成された 9:16 MP4・audit manifest・`publish` APPROVED decision を配置して `src/release-readiness-cli.ts` を 2 回連続実行することで、最終公開前の整合を検証します。`--now` を固定すれば report SHA-256 は A/B 一致します。最新の exact head・run_id・test count・report SHA-256・ffprobe 結果・4 入力不変性・敵対的テスト結果などの可変証拠は PR #18 本文 / コメントで一元管理し、README ではプロトコル概要のみ記載します（tip SHA などの可変値を埋め込む運用は停止しました）。

#### release-readiness コミットプロトコル

1. Node 側で 4 入力（MP4、audit manifest、audit output artifact、approval decision）の canonical path・parent directory identity・`dev/ino/size/mtimeNs/ctimeNs`・SHA-256 を事前検証します。
2. Python helper は各入力を fd-relative `O_RDONLY | O_NOFOLLOW` で開き、stat/realpath/SHA-256 を確認した上で sealed `memfd_create` (`F_ADD_SEALS`) へコピーします。
3. **4 入力と report temp の seal 後・`os.link` 直前**に、helper は各入力の original canonical path をもう一度開き、parent directory identity・file stat・realpath・SHA-256 を再検証します。copy 後〜final link 前の rewrite / same-content replacement / truncation / growth / parent-directory swap はここで `INPUT_CHANGED` となります。
4. report temp も sealed `memfd` へコピーし、出力ディレクトリ内に `O_TMPFILE` 匿名 inode を作成、内容を書き込み、`fsync`・`fchmod 0o400` の上で `os.link("/proc/self/fd/<tmp>", final_name, dst_dir_fd=output_dir_fd, follow_symlinks=True)` により atomic no-replace で最終パスを公開します。`FileExistsError` は `OUTPUT_COLLISION` です。
5. `os.link` 成功後、helper は `linked` JSON（`dev`/`ino`/`size`/`mtimeNs`/`ctimeNs`）を出力し、正常 success を含む全 linked パスで TypeScript 側 `verifyFinalCommit` が実行されます。`verifyFinalCommit` は dir-fd relative `O_NOFOLLOW` オープン、pre/post `fstat`、EOF 追加読み、path identity、linked inode provenance 比較を行います。

`tests/release-readiness.test.ts` には、copy 後〜final link 前の各入力に対する rewrite / replacement / truncate / grow / parent-directory swap を `INPUT_CHANGED` で検出する敵対的テストと、post-link foreign-replacement / growth / helper failure / malformed テストが含まれます。

`.github/workflows/ci.yml` は KER-316 の変更禁止ファイルのため、hosted Actions 向け `ffmpeg` インストールと `/usr/bin/node` シンボリックリンクは元に revert しています。hosted GitHub Actions は本 issue の受入判定対象外です。

## 素材区間 manifest

決定論的な素材区間 manifest を生成するには、カタログ生成後に以下を実行します。

```bash
npx tsx src/catalog-cli.ts fixtures output/catalog.json
npx tsx src/media-segments-cli.ts output/catalog.json fixtures
```

`output/media-segments/manifest.json` に video / audio 素材の全尺区間 `[0, duration]` と安定 segment ID が記録されます。画像、error entry、duration 欠損 / 非有限 / 0 以下の entry は除外されます。詳細は `docs/media-segments.md` を参照してください。

### 明示選択した素材区間から Timeline JSON を生成する

video segment ID を順序付きで明示選択すると、既存 `TimelineSchema` に合格する 9:16 Timeline JSON を `output/timelines/` へ決定論的に生成できます。v1 は video segment 1〜5 件のみ許可し、audio / image / 未知 ID / 重複 ID は fail closed で拒否します。

```bash
npx tsx src/catalog-cli.ts fixtures output/catalog.json
npx tsx src/media-segments-cli.ts output/catalog.json fixtures
npx tsx src/segment-selection-cli.ts output/media-segments/manifest.json selection.json fixtures
```

生成された `output/timelines/selection.json` は既存の `npm run generate:video -- output/timelines/selection.json` で 1080x1920 MP4 へレンダーできます。詳細は `docs/segment-selection.md` を参照してください。

## 手動タイムコード付き transcript manifest

手動でタイムコード付き transcript ソース JSON を media segment manifest へ取り込み、`output/transcripts/manifest.json` へ決定論的に出力できます。

```bash
npx tsx src/transcript-manifest-cli.ts \
  fixtures/transcript-media-segments.json \
  fixtures/transcript-source.json \
  fixtures \
  output/transcripts/manifest.json
```

`text` のみ必須で、`speaker` と `confidence` は省略可能です。`0 <= start < end <= segment.duration`、非有限値・制御文字・NUL・surrogate・重複 key・未知 segment ID・画像区間を fail closed で拒否します。出力パスは `output/transcripts/<file>.json` のみ許可され、書き込み完了後に `output/transcripts/` 内の匿名 `O_TMPFILE` inode を単一 `os.link('/proc/self/fd/<fd>', finalName, dst_dir_fd=...)` で no-replace 公開します。公開後も TypeScript 側で `O_NOFOLLOW` オープンし、保持中の `O_TMPFILE` fd と `dev`/`ino`/`size`・再読み SHA-256・path identity を照合する `verifyFinalCommit` を実行するため、helper の post-link 異常終了 / malformed output / timeout / foreign replacement 後も foreign final は破壊されず、zero-byte / 部分ファイルは観測されません。

現在の fixtures で生成される manifest の SHA-256:

```
f4750dc6eebed688a3ddd0841b232acffc5cbeaff285033e80c9e84c51c22b8d  output/transcripts/manifest.json
598c5ac78999e24bb882672d6dd1bde087c2b76bd5edf63c0363ccfb79ef281a  fixtures/transcript-manifest-multi.json
```

## 字幕付き Timeline JSON 生成（transcript manifest 接続）

KER-314 で明示選択した video segment と KER-317 の transcript manifest から、既存レンダラーで直接焼き込める字幕付き Timeline JSON を決定論的に生成できます。

```bash
npx tsx src/transcript-manifest-cli.ts \
  fixtures/transcript-media-segments.json \
  fixtures/transcript-source.json \
  fixtures \
  output/transcripts/manifest.json

npx tsx src/transcript-subtitle-timeline-cli.ts \
  fixtures/transcript-media-segments.json \
  fixtures/transcript-selection.json \
  output/transcripts/manifest.json \
  fixtures/transcript-subtitle-style.json \
  fixtures \
  timelines/subtitled.json

npm run generate:video -- output/timelines/subtitled.json

# multi-clip 字幕付き Timeline
npx tsx src/transcript-subtitle-timeline-cli.ts \
  fixtures/transcript-media-segments-multi.json \
  fixtures/transcript-selection-multi.json \
  fixtures/transcript-manifest-multi.json \
  fixtures/transcript-subtitle-style.json \
  fixtures \
  timelines/subtitled-multi.json

npm run generate:video -- output/timelines/subtitled-multi.json
```

`fixtures/transcript-subtitle-style.json` は `font`、`fontHash`、`x`、`y`、`fontSize` のみを持つ固定スキーマです。`font` は `fonts/` 直下の単一 face `.ttf` / `.otf` で、`fontHash` は実ファイル SHA-256 と一致する必要があります。選択順で clip が連結され、各 utterance は `clip.start + (utterance.start - segment.start)` を絶対時刻として subtitle cue に写像されます。選択外 segment の utterance は出力されず、utterance が無い選択 segment も clip は保持されます。最大 20 cue・最大 100 文字・制御文字・secret-like テキスト・タイムライン範囲外は fail closed で拒否されます。

詳細は `docs/transcript-subtitle-timeline.md` を参照してください。

## ライセンス

本リポジトリは [MIT License](LICENSE) のもとで公開されています。`fonts/` や `fixtures/` に配置する第三者フォント・素材は、それぞれのライセンス条項に従ってください。
