# 副作用アクションの明示承認 gate (KER-315)

`src/approval.ts` / `src/approval-cli.ts` は、実際の公開・削除・外部送信を伴わず、それらの副作用アクションに対する明示的な承認 gate です。

## 対象アクション

承認を必要とするアクションは厳密な enum です。

- `publish`
- `delete`
- `external-send`

## 入力

- **Request** (`<projectRoot>/...`): 副作用アクション、対象 artifact の canonical 識別子 (`output/...`)、artifact ファイルの SHA-256
- **Receipt** (`<projectRoot>/...`): 承認者が発行した承認レシート

Request と Receipt は両方とも `output/` 配下以外の任意のプロジェクト相対パスに配置できますが、Request / Receipt / artifact と gate の decision 出力 (`output/approvals/<requestSha256>.json`) が同一パス・同一 inode・シンボリックリンクで衝突している場合は拒否されます。

### artifact 識別子の canonical 制約

`artifact` 識別子は **byte-for-byte canonical な POSIX relative path** として厳密に検証されます。

- 先頭は `output/` でなければなりません
- `\`、空 component (`//`)、末尾 `/`、`.`、`..`、absolute path、Windows drive path、`UNC` path は fail-closed で拒否されます
- パス component にシンボリックリンクが含まれる場合も拒否されます
- 正規化によって異なる表記を同一ファイルに解決することはありません（`output//x` や symlink alias は別識別子として扱われます）

## Receipt のスキーマ

```json
{
  "requestHash": "<request canonical SHA-256>",
  "action": "publish",
  "artifact": "output/video.mp4",
  "artifactSha256": "<artifact file SHA-256>",
  "approved": true,
  "approver": "alice",
  "approvedAt": "2026-07-31T12:00:00Z",
  "expiresAt": "2026-07-31T13:00:00Z"
}
```

- `approvedAt` / `expiresAt` / `now` は厳密な RFC3339 形式で、暦日上存在しない日付（2月30日など）や時刻範囲外、round-trip 不能な表現は拒否されます。timezone offset も parse → 元の文字列表現への round-trip で検証されます
- `approvedAt` は `expiresAt` より前である必要があります
- `now` が `approvedAt` より前なら future timestamp 拒否
- `now` が `expiresAt` 以降なら expired 拒否
- 上記すべてに加えて action / artifact / artifactSha256 / requestHash が request と exact-match である必要があります

## Decision 出力

承認 gate は実際の side-effect を一切実行せず、判定結果を atomically に `output/approvals/<requestSha256>.json` に書き込みます。書き込みは `writeJsonAtomic` の temp + rename で行われ、rename 直前に `beforeRename` barrier 内で全入力を再検証します。

```json
{
  "action": "publish",
  "approver": "alice",
  "artifact": "output/video.mp4",
  "artifactSha256": "<artifact file SHA-256>",
  "decision": "approved",
  "reasonCode": "APPROVED",
  "requestSha256": "<request canonical SHA-256>",
  "schemaVersion": "1.0.0",
  "verifiedAt": "2026-07-31T12:00:00.000Z"
}
```

`reasonCode` は `APPROVED`、または拒否事由のコードです。`decision` レコードには絶対パスやシークレットは含まれません。さらに、canonical 検証に失敗した artifact identifier は decision には保存されず、`artifact` は `[INVALID_ARTIFACT_IDENTIFIER]`、`artifactSha256` は `0` 詰めの 64 文字に置き換えられます。

## Library API

```typescript
import { verifyApproval, canonicalSha256, ApprovalError } from './src/approval.js';

const result = await verifyApproval(
  '/project/root',
  'requests/publish.json',
  'receipts/publish.json',
  { now: new Date('2026-07-31T12:00:00Z') },
);

if (result.approved) {
  console.log('approved', result.decisionSha256, result.decisionPath);
} else {
  console.log('denied', result.reasonCode);
}
```

`now` を注入することで、テストや再実行時の決定論的な検証が可能です。

## CLI

```bash
npx tsx src/approval-cli.ts \
  --project-root /project/root \
  --request requests/publish.json \
  --receipt receipts/publish.json \
  --now 2026-07-31T12:00:00Z
```

承認されると終了コード 0、拒否・エラー時は 1 で JSON を stderr/stdout に出力します。CLI はあくまで承認判定を行い、実際の publish / delete / external-send は実行しません。

## セキュリティ契約

- Request / Receipt は bounded UTF-8 JSON として読み込まれ、重複キーは fail-closed です
- artifact 識別子は byte-for-byte canonical POSIX relative path (`output/...`) のみを許可します
- artifact は `output/` 下の通常ファイルである必要があり、シンボリックリンクは拒否されます
- artifact の読み取り中にサイズ変更・inode 変更・シンボリックリンク化が検出された場合も拒否されます
- **検証 snapshot の維持**: 初回検証で取得した request / receipt / artifact の canonical realpath、dev/ino、size、mtime、SHA-256 を保持し、decision 公開（`writeJsonAtomic.beforeRename`）直前に再検証します
- rename 前の再検証に失敗した場合、入力ファイル・既存 decision final は不変に保たれ、temp ファイルは削除されます
- 同一の request + receipt + `now` からは同じ decision JSON と SHA-256 が生成されます
- 既存の `resolveSafePath` / `sha256File` / `readJsonFileSafe` / `resolveOutputPath` / `writeJsonAtomic` / `isInside` を再利用し、安全契約の重複実装を避けています
