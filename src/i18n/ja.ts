/**
 * 日本語文言辞書（§4.7）。
 *
 * このオブジェクトのキー集合が全 UI 文言の「正」となり、`MessageKey` 型と
 * 英語辞書（en.ts）の網羅性を型レベルで強制する（index.ts 参照）。
 */

export const ja = {
  // ---- アプリ全体・ヘッダー ----
  appTitle: 'LUT Match',
  appTagline: '2 枚の画像から色を合わせる 3D LUT を自動生成',
  langToggle: 'English',
  langToggleAria: '言語を英語に切り替える',
  helpAria: '使い方を表示',

  // 進行インジケーター（§6.0）
  step1: '画像を選ぶ',
  step2: '調整',
  step3: '書き出し',

  // ---- 入力（ドロップゾーン・§4.1 / §6.2）----
  sourceTitle: '元画像 (Source)',
  referenceTitle: '参考画像 (Reference)',
  dropHint: 'ドラッグ＆ドロップ または クリックで選択',
  dropReplaceHint: 'クリックで差し替え',
  dropFormats: 'JPEG / PNG / WebP',
  sampleButton: 'サンプル画像で試す',
  guideSource: 'まず元画像を選んでください',
  guideReference: '参考画像を選んでください',

  // ---- 自動マッチ（モード・§4.2）----
  modeLabel: '自動マッチ',
  modeAName: 'ナチュラル',
  modeBName: '忠実',
  modeCName: 'バランス',
  modeADesc: '線形マッチのみ。破綻を避けたい・被写体が大きく異なるときに。',
  modeBDesc: 'チャンネル別ヒストグラムマッチ。トーンごと強く寄せたいときに。',
  modeCDesc: '複合パイプライン（既定）。非線形の再現と安定性を両立。',

  // ---- 強度・詳細調整（§4.4）----
  strengthLabel: '強度',
  strengthTooltip: '自動マッチ結果と元の色のブレンド率。手動調整には影響しません。',
  detailsTitle: '詳細調整',
  smoothingLabel: 'スムージング',
  smoothingTooltip: 'LUT を 3D 平滑化してバンディング・色飛びを抑えます。',
  exposureLabel: '露出',
  exposureTooltip: '明るさ（EV）。リニア空間で ×2^EV を掛けます。',
  contrastLabel: 'コントラスト',
  contrastTooltip: '中間グレー基準の S カーブでメリハリを調整します。',
  saturationLabel: '彩度',
  saturationTooltip: '色の鮮やかさを増減します。',
  temperatureLabel: '色温度',
  temperatureTooltip: '青⇄黄の色みを調整します（Lab の b* 軸）。',
  tintLabel: 'ティント',
  tintTooltip: '緑⇄マゼンタの色みを調整します（Lab の a* 軸）。',
  blackLabel: 'ブラック保護',
  blackTooltip: '指定輝度以下を統計マッチから除外し、締まった黒を保ちます。',
  resetButton: '手動調整をリセット',

  // ---- プレビュー（§4.5）----
  tabOriginal: '元画像',
  tabResult: '適用後',
  tabCompare: '比較',
  referenceThumbAlt: '参考画像（目標）',
  previewEmpty: '画像を選ぶとここにプレビューが表示されます',
  computing: '計算中…',
  compareHandleAria: '比較スライダー（左右キーで移動）',

  // ---- 書き出し（§4.6）----
  exportSizeLabel: 'サイズ',
  fileNameLabel: 'ファイル名',
  downloadButton: 'LUT をダウンロード',
  savePngButton: '適用後を PNG 保存',
  exportDetailsAria: 'ファイル名・サイズの詳細',

  // ---- トースト・エラー（§6.2）----
  errUnsupported: 'この形式は読み込めません。JPEG に変換してからお試しください。',
  errDecode: '画像の読み込みに失敗しました。別の画像でお試しください。',
  errSample: 'サンプル画像の読み込みに失敗しました。',
  errGenerate: '計算に失敗しました。もう一度お試しください。',
  warnFallback: '統計が不安定なため簡易マッチ（平均シフト）に切り替えました。',
  warnCanvas2d: 'WebGL が使えないため Canvas 2D 描画に切り替えました。',
  toastClose: '閉じる',

  // ---- ヘルプモーダル（§6.4）----
  helpTitle: '使い方',
  helpStep1Title: '1. 元画像を選ぶ',
  helpStep1Body: '色を変えたい写真（Source）を読み込みます。',
  helpStep2Title: '2. 参考画像を選ぶ',
  helpStep2Body: '目標にしたい雰囲気の写真（Reference）を読み込みます。',
  helpStep3Title: '3. 調整して書き出す',
  helpStep3Body: 'モードと強度で追い込み、.cube をダウンロードします。',
  helpRangeTitle: 'LUT が扱える範囲',
  helpRangeBody:
    'LUT は「色の置き換え」だけを行います。粒状感（グレイン）・ボケ・ビネットなど空間的な効果は再現できません。被写体が近い 2 枚ほど良い結果になります。',
  helpClose: '閉じる',

  // ヒント（§6.4）
  firstHint:
    'このツールは参考画像の「色の雰囲気」を移します。被写体や明るさが近い 2 枚ほど自然に仕上がり、まったく異なる場面同士ではうまく合いません。',
} as const;
