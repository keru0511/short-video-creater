---
name: Testing short-video-creater
description: End-to-end testing notes for the short-video-creater GUI and MCP server.
---

# Testing short-video-creater

## Devin Secrets Needed
None.

## Pre-test setup
- Node.js 20.x, npm 10.8.x, and FFmpeg 4.x+ must be available.
- Run `npm install` and `npm run generate:fixtures` to create test fixtures and fonts.
- Run `npm run setup:fonts` if `fonts/DejaVuSans.ttf` or `fonts/IPAGothic.ttf` are missing.

## Starting the GUI
- Prefer `GUI_PORT=0 npm run gui` so the OS assigns a free port; the default fixed port (`9876`) may already be in use and will fail with `EADDRINUSE`.
- `npm run gui:launch` may hang or fail to open a browser; use `GUI_PORT=0 npm run gui` and then open the logged URL manually.

## GUI automation gotchas
- The asset dropzone overlays an `opacity: 0` `<input type="file">` over the dropzone; the browser tool can target this input directly while keeping the dropzone clickable for users.
- If the hidden file input is not assigned a `devinid` or `select_file` cannot target it, seed assets via `curl`:
  ```
  curl -F "file=@<fixture>" -H "Origin: http://127.0.0.1:<port>" http://127.0.0.1:<port>/api/projects/<projectId>/assets
  ```
  Then reload the GUI or click **読み込む** to see the asset.
- The multi-select `select_file` tool may only upload one file per call; upload fixtures individually if needed.
- Timeline clip values (`in`/`out`) are number inputs; direct typing can append instead of replace. Use a console snippet to set `input.value` and dispatch a `change` event for reliable updates.
- The **主音声** track must be at least as long as the final video duration. If the chosen audio is shorter, `buildProjectTimeline` rejects with `主音声(...s)が動画の長さ(...s)より短いです`. Either choose a longer audio file or leave `主音声` unset.
- BGM `start`/`out` must fit within the final video duration, otherwise generation fails.

## Persistence behavior
- Asset catalog (`gui/projects/<projectId>/input/`) persists across reloads.
- Timeline clip state is persisted to `gui/projects/<projectId>/timeline.json` automatically when edited and restored on page load.
- The project ID can be passed in the URL query string as `?project=<projectId>`, which pre-fills the input and loads the project.
- When you enter a project ID and click **読み込む** (or press Enter), the URL is updated to `?project=<projectId>` and the ID is saved to `localStorage['short-video-creater.projectId']`.
- On reload, the GUI restores the last project ID from the URL query first, then from `localStorage`, so the timeline is restored automatically.

## Subtitles
- Use the transcript textarea to import JSON like `[{"start":0,"end":1.5,"text":"Hello"}]`.
- Transcript cues are mapped to each timeline clip segment they overlap, so the number of generated subtitle rows can be larger than the number of input cues.

## Verifying exports
- Generated MP4s live under `gui/output/artifacts/<jobId>/snapshot-video.mp4`.
- Probe with: `ffprobe -v error -select_streams v:0 -show_entries stream=width,height,codec_name -of csv=s=x:p=0 <file>`.
- Expected: `width=1080`, `height=1920`, `codec_name=h264`, audio codec `aac`, duration ≈ timeline total length.

## Trend/viral clip suggestions
- The new "トレンド分析" panel in the GUI uses cached analyses stored in `gui/projects/<projectId>/trend-analysis.json` and writes exported clip usage to `gui/projects/<projectId>/usage.json`.
- The REST endpoints are `GET /api/projects/<projectId>/clips/suggest` and `POST /api/projects/<projectId>/timeline/autofill`. The autofill POST may require an `Origin` or `Referer` header from the browser.
- The MCP server adds `suggest_trending_clips` and `autofill_timeline` tools; `export_video` records usage after export.
- Trend suggestion cards render with a `[<type>]` prefix in the title and meta line where `<type>` is the asset type (`video`, `image`, `audio`).
- `video` and `image` cards show a `クリップに追加` button; `audio` cards show `主音声に設定` and `BGMに設定` buttons.
- The scorer cannot naturally emit `image` suggestions (`trend-scorer.ts` returns empty features for images), so seed a synthetic `gui/projects/<projectId>/trend-analysis.json` cache with the image asset's `contentHash` if you need to exercise the `[image]` UI branch.
- `getTrendingClipSuggestions` in `src/gui/project.ts` analyzes `video` and `audio` assets and includes their suggestions; `[audio]` suggestion cards are reachable end-to-end, while `autofillTimelineWithTrendingClips` skips audio suggestions so they are not added as visual clips.
- When testing, create a synthetic video with scene changes and varying audio (e.g. `ffmpeg` `color` + `sine` with volume changes) so the scorer returns non-empty suggestions.
- `autofillTimelineWithTrendingClips` now de-duplicates against existing timeline clips and previously exported ranges, so it will not append overlapping suggestions.

## MCP server
- Start with `npm run mcp-server` and drive via stdin JSON-RPC 2.0.
- Useful tools to test: `upload_media`, `add_clip`, `set_clip_range`, `split_clip`, `add_subtitle`, `export_video`.
- `export_video` returns `outputUrl` and `probe`; verify the referenced `gui/output/artifacts/.../snapshot-video.mp4` file exists and probes correctly.
