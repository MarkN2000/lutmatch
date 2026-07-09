# LUT Match

元画像（Source）と参考画像（Reference）の2枚から、色味を近づける3D LUT（`.cube`）を自動生成するWebアプリです。すべての処理はブラウザ内で完結し、画像がサーバーへ送信されることはありません。

詳細な仕様は [spec.md](./spec.md) を参照してください。

## 主な機能

- 3モードの自動カラーマッチ（ナチュラル / 忠実 / バランス）
- 露出・コントラスト・彩度・色温度・ティントなどの手動調整
- ビフォーアフター比較プレビュー（WebGL、非対応環境では Canvas 2D にフォールバック）
- 日本語・英語 UI（i18n）
- 生成した LUT を `.cube` 形式で書き出し

## 開発コマンド

```bash
npm run dev         # 開発サーバー起動
npm run build       # 型チェック + 本番ビルド（dist/ に出力）
npx vitest run      # テスト実行
npm run typecheck   # 型チェックのみ（tsc --noEmit）
npm run gen:samples # サンプル画像の生成
```

## 技術スタック

- Vite + TypeScript（フレームワークなしの Vanilla TS）
- 外部ランタイム依存はゼロ（devDependencies は vite / typescript / vitest のみ）

## デプロイ

Cloudflare Pages にホスティングします。`vite build` の成果物（`dist/`）をそのまま配信する静的サイト構成です。

## ライセンス

MIT
