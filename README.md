# LUT Match

元画像（Source）と参考画像（Reference）の2枚から、色味を近づける 3D LUT（`.cube`）を自動生成する Web アプリです。

たとえば「デジタルカメラで普通に撮った写真」と「フィルムカメラで撮った写真」を入れると、フィルム風の色になる LUT が得られます。生成した `.cube` は DaVinci Resolve / Premiere Pro / Photoshop / OBS など `.cube` 対応ソフトでそのまま使えます。

**すべての処理はブラウザ内で完結し、画像がサーバーへ送信されることはありません。**

詳細な仕様は [spec.md](./spec.md) を参照してください。

## 使い方

1. **画像を選ぶ** — Source（LUT を適用したい元画像）と Reference（目標の雰囲気の画像）をドラッグ＆ドロップ。初めての場合は「サンプル画像で試す」ボタンでデモできます
2. **調整** — 自動マッチのモードを3つから選び、強度スライダーや詳細調整（露出・コントラスト・彩度・色温度・ティントなど）で追い込みます。比較スライダーでビフォーアフターを確認できます
3. **書き出し** — サイズ（17 / 33 / 65）とファイル名を指定して `.cube` をダウンロード。確認用に適用後画像の PNG 保存もできます

### 自動マッチの3モード

| モード | 内部処理 | 向いている場面 |
|---|---|---|
| ナチュラル | MKL（線形カラーマッチ）のみ | 破綻を避けたい・被写体が大きく異なる場合 |
| 忠実 | ヒストグラムマッチングのみ | トーンカーブごと強く寄せたい場合 |
| バランス（既定） | HM → MKL → HM の複合 | 通常はこれ。再現性と安定性の両立 |

> ヒント：Source と Reference の被写体・光の条件が近いほど自然な結果になります。

## 対応環境

- Chrome / Edge / Firefox / Safari の最新2メジャーバージョン
- モバイル（iOS Safari / Android Chrome）対応
- 対応画像形式：JPEG / PNG / WebP（HEIC は事前に JPEG へ変換してください）
- プレビューは WebGL2（3D テクスチャ）。非対応環境では自動的に Canvas 2D にフォールバックします

## 開発

```bash
npm install
npm run dev         # 開発サーバー起動
npm run build       # 型チェック + 本番ビルド（dist/ に出力）
npx vitest run      # テスト実行
npm run typecheck   # 型チェックのみ（tsc --noEmit）
npm run gen:samples # サンプル画像の再生成
```

### 技術スタック

- Vite + TypeScript（フレームワークなしの Vanilla TS）
- 外部ランタイム依存はゼロ（devDependencies は vite / typescript / vitest のみ）
- 重い計算は Web Worker、プレビュー描画は WebGL2（+ Canvas 2D フォールバック）

### ディレクトリ構成

```
src/
├─ core/     # 純粋なアルゴリズム層（色空間変換・MKL・ヒストグラムマッチ・LUT 生成・.cube 出力）
├─ worker/   # Web Worker（自動マッチ計算・.cube シリアライズ）
├─ io/       # 画像デコード（createImageBitmap ベース）
├─ gl/       # プレビューレンダラー（WebGL2 / Canvas 2D）
├─ ui/       # UI コンポーネント（素の DOM + CSS）
└─ i18n/     # 日英の文言辞書
tests/       # vitest（core/ 対象のユニット・同一性・ゴールデンテスト）
scripts/     # サンプル画像の生成スクリプト
```

### アルゴリズム概要

- 統計計算はリニア化した RGB 上で実施（解析解像度は長辺 512px）
- MKL は Monge-Kantorovich 線形化の閉形式解（Pitié & Kokaram 2007）。グレースケール等の退化入力は平均シフトへ自動フォールバック
- ヒストグラムマッチングはガンマ空間の 256 ビン CDF マッチング＋カーブの残差平滑化（暗部ノイズの増幅を抑制）
- LUT 格子には入力画像に存在しない色域（外挿域）を Identity 方向へ減衰させる保護、3D ガウシアン平滑化、Identity ミックス（強度）を適用

詳細は [spec.md](./spec.md) の §5 を参照してください。

## デプロイ

Cloudflare Pages にホスティングします。`vite build` の成果物（`dist/`）をそのまま配信する静的サイト構成です。

- ビルドコマンド: `npm run build`
- 出力ディレクトリ: `dist`

CI（GitHub Actions）は push / PR ごとに型チェック・テスト・ビルドを実行します。

## ライセンス

MIT
