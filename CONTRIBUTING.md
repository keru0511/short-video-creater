# Contributing to short-video-creater

このリポジトリは MIT ライセンスで公開されています。バグ報告、機能提案、Pull Request を歓迎します。

## 報告する前に

- 既存の Issue で同様の内容がないか検索してください。
- セキュリティに関する脆弱性は [Security Advisories](https://github.com/keru0511/short-video-creater/security/advisories/new) から非公開で報告してください。

## 開発セットアップ

```bash
mise install
npm ci
npm run lint
npm test
```

`mise` を使わない場合は Node.js 20.x と npm 10.8.x をご用意ください。

## Pull Request ガイドライン

- `main` ブランチ宛てに出してください。
- `npm run lint`、`npm run typecheck`、`npm run build`、`npm test` がすべて通る状態にしてください。
- 変更内容はテストでカバーし、既存のテストが壊れないようにしてください。
- コミットメッセージは変更の意図がわかるように簡潔にまとめてください。

## レビュー後

レビュアーからの指摘に対応後、CI がすべて通過すればマージ可能です。
