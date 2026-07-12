/**
 * アプリ結線・状態管理（§6 全体）。
 *
 * 役割：
 * - レイアウト（ヘッダー / 左レール / プレビュー / 書き出しバー）を組み立てる
 * - 画像ロード → 自動マッチ（Worker）→ プレビュー反映 → .cube / PNG 書き出しの
 *   データフローを一元管理する
 * - スライダー/モード/サイズ変更 → デバウンス再計算（Worker supersede 活用）
 *
 * 描画バックエンド・重い計算はそれぞれ gl/preview・worker が担い、本モジュールは
 * 「状態の単一の持ち主」として振る舞う（SOLID: 責務分離）。
 */

import './style.css';

import { append, clear, debounce, el } from './ui/dom.ts';
import { onLangChange, t, toggleLang } from './i18n/index.ts';
import { createDropzone, type DropzoneHandle } from './ui/dropzone.ts';
import { createModeSegment } from './ui/segment.ts';
import { createSlider, type SliderHandle } from './ui/slider.ts';
import { createAccordion } from './ui/accordion.ts';
import { createCurves } from './ui/curves.ts';
import { createPreview } from './ui/preview.ts';
import { createExportBar } from './ui/exportbar.ts';
import { createToastHost } from './ui/toast.ts';
import { createHelpModal } from './ui/help.ts';
import { renderResultPng } from './ui/export-png.ts';

import { loadImage, ImageLoadError, type LoadedImage } from './io/image.ts';
import { MatchWorkerClient, SupersededError } from './worker/client.ts';
import type { GenerateLutRequestPayload } from './worker/protocol.ts';
import { CURVE_BINS, HIST_BINS, NEUTRAL_ADJUSTMENTS, srgbToLinear, type GenerateLutOptions, type MatchMode } from './core/index.ts';
import { buildResonitePackage, OLD_LUT_HASH } from './core/resonite/package.ts';

// ============================================================
// 定数・既定値（§4.4）
// ============================================================

const DEFAULTS: Record<string, number> = {
  strength: 80,
  smoothing: 20,
  noiseSuppression: 0,
  exposure: 0,
  contrast: 0,
  saturation: 0,
  temperature: 0,
  tint: 0,
  blackProtection: 5, // %（0–20）。UI は知覚（sRGB）輝度%。sample.blackThreshold へは srgbToLinear(%/100) でリニア輝度に変換して渡す
};

const ALPHA_THRESHOLD = 0.5;
const RECOMPUTE_DEBOUNCE_MS = 100;

// ============================================================
// アプリ状態
// ============================================================

const state = {
  mode: 'C' as MatchMode,
  strength: DEFAULTS.strength,
  smoothing: DEFAULTS.smoothing,
  noiseSuppression: DEFAULTS.noiseSuppression,
  exposure: DEFAULTS.exposure,
  contrast: DEFAULTS.contrast,
  saturation: DEFAULTS.saturation,
  temperature: DEFAULTS.temperature,
  tint: DEFAULTS.tint,
  blackProtection: DEFAULTS.blackProtection,
  source: null as LoadedImage | null,
  reference: null as LoadedImage | null,
  currentLut: null as Float32Array | null,
  currentLutSize: 0,
  activeDrags: 0,
  loadGeneration: { source: 0, reference: 0 } as Record<Role, number>,
};

const worker = new MatchWorkerClient();

// ============================================================
// DOM 構築
// ============================================================

const appRoot = document.querySelector<HTMLDivElement>('#app');
if (!appRoot) throw new Error('#app が見つかりません');
clear(appRoot);

// ---- ヘッダー ----
const header = el('header', 'app-header');
const brand = el('div', 'app-header__brand');
const brandTitle = el('h1', 'app-header__title');
const brandTag = el('p', 'app-header__tagline');
append(brand, brandTitle, brandTag);

const headerActions = el('div', 'app-header__actions');
const langBtn = el('button', 'btn btn--ghost app-header__lang');
langBtn.type = 'button';
langBtn.addEventListener('click', () => toggleLang());
const helpBtn = el('button', 'btn btn--icon app-header__help');
helpBtn.type = 'button';
helpBtn.textContent = '?';
append(headerActions, langBtn, helpBtn);

append(header, brand, headerActions);

// ---- 入力ブロック ----
const inputsBlock = el('section', 'panel block-inputs');
const dzRow = el('div', 'dropzone-row');
const dropSource: DropzoneHandle = createDropzone('source', (f) => handleFile('source', f), () => clearImage('source'));
const dropReference: DropzoneHandle = createDropzone('reference', (f) => handleFile('reference', f), () => clearImage('reference'));
append(dzRow, dropSource.element, dropReference.element);

const sampleBtn = el('button', 'btn btn--ghost sample-btn');
sampleBtn.type = 'button';
sampleBtn.addEventListener('click', () => void loadSamples());

// ヒント（§6.4）。常時表示。
const hintBanner = el('div', 'hint');
const hintText = el('span', 'hint__text');
append(hintBanner, hintText);

append(inputsBlock, dzRow, sampleBtn, hintBanner);

// ---- コントロールブロック ----
const controlsBlock = el('section', 'panel block-controls');

// 「自動調整」アコーディオン（モード3択・強度・ノイズ抑制、§6.0 原則3）。
// 見出しはセグメント自身が持つ aria-label と同じ i18n キー `modeLabel` を再利用し、
// 見出しラベルの重複表示を避ける（旧 modeLabel 単独ラベル div は廃止）。
const autoAccordion = createAccordion('modeLabel');

const modeSegment = createModeSegment(state.mode, (mode) => {
  state.mode = mode;
  updateNoiseSuppressionDisabled();
  scheduleRecompute();
});

const strengthSlider = createSlider({
  labelKey: 'strengthLabel',
  tooltipKey: 'strengthTooltip',
  min: 0,
  max: 100,
  step: 1,
  value: state.strength,
  defaultValue: DEFAULTS.strength,
  format: (v) => `${Math.round(v)}%`,
  onInput: (v) => {
    state.strength = v;
    scheduleRecompute();
  },
  onDragState: setDragState,
});

// ノイズ抑制は「自動調整」アコーディオン内・強度の隣（§6.0）。モード A では無効化される（updateNoiseSuppressionDisabled）。
const noiseSuppressionSlider = makeParamSlider('noiseSuppressionLabel', 'noiseSuppressionTooltip', 0, 100, 1, DEFAULTS.noiseSuppression, (v) => `${Math.round(v)}`, (v) => (state.noiseSuppression = v));

// 「自動調整」の 3 コントロールをアコーディオン本体へ格納する（配置順は従来どおり）。
append(autoAccordion.body, modeSegment.element, strengthSlider.element, noiseSuppressionSlider.element);

// カーブエディタ（独立アコーディオン・既定閉／§5.7・§6.1）。ノイズ抑制と「詳細調整」の間に置く。
const curves = createCurves();
// 編集（点追加・ドラッグ中の move ごとも含む）→ デバウンス再計算。
curves.onChange(() => scheduleRecompute());
// ドラッグ中は既存スライダーと同じ経路で Canvas 2D フォールバックの draft/full 品質を切り替える。
curves.onDragState(setDragState);

const accordion = createAccordion('detailsTitle');

// 詳細 7 項目（§4.4・§6.0）。
const smoothingSlider = makeParamSlider('smoothingLabel', 'smoothingTooltip', 0, 100, 1, DEFAULTS.smoothing, (v) => `${Math.round(v)}`, (v) => (state.smoothing = v));
const exposureSlider = makeParamSlider('exposureLabel', 'exposureTooltip', -2, 2, 0.05, DEFAULTS.exposure, (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)} EV`, (v) => (state.exposure = v));
const contrastSlider = makeParamSlider('contrastLabel', 'contrastTooltip', -50, 50, 1, DEFAULTS.contrast, fmtSigned, (v) => (state.contrast = v));
const saturationSlider = makeParamSlider('saturationLabel', 'saturationTooltip', -100, 100, 1, DEFAULTS.saturation, fmtSigned, (v) => (state.saturation = v));
const temperatureSlider = makeParamSlider('temperatureLabel', 'temperatureTooltip', -100, 100, 1, DEFAULTS.temperature, fmtSigned, (v) => (state.temperature = v));
const tintSlider = makeParamSlider('tintLabel', 'tintTooltip', -100, 100, 1, DEFAULTS.tint, fmtSigned, (v) => (state.tint = v));
const blackSlider = makeParamSlider('blackLabel', 'blackTooltip', 0, 20, 1, DEFAULTS.blackProtection, (v) => `${Math.round(v)}%`, (v) => (state.blackProtection = v));

// 有効条件で 2 群に分ける（§4.4 の有効/無効マトリクス）。
// - 手動群: source があれば有効（恒等基底の手動 LUT 作成でも使う）
// - 統計群: source && reference のときのみ有効（自動マッチ由来のパラメーター）
const manualSliders: SliderHandle[] = [
  exposureSlider,
  contrastSlider,
  saturationSlider,
  temperatureSlider,
  tintSlider,
];
const statSliders: SliderHandle[] = [smoothingSlider, blackSlider];

// キー付きで保持し、詳細調整の一括リセット（DETAIL_SLIDERS）と DOM 配置の両方で使い回す（DRY）。
type DetailKey = 'smoothing' | 'exposure' | 'contrast' | 'saturation' | 'temperature' | 'tint' | 'blackProtection';
const DETAIL_SLIDERS: Array<{ slider: SliderHandle; key: DetailKey }> = [
  { slider: smoothingSlider, key: 'smoothing' },
  { slider: exposureSlider, key: 'exposure' },
  { slider: contrastSlider, key: 'contrast' },
  { slider: saturationSlider, key: 'saturation' },
  { slider: temperatureSlider, key: 'temperature' },
  { slider: tintSlider, key: 'tint' },
  { slider: blackSlider, key: 'blackProtection' },
];

// DOM への配置は従来の表示順（スムージング → 露出 → … → ブラック保護）を維持する。
for (const { slider } of DETAIL_SLIDERS) {
  append(accordion.body, slider.element);
}

// 「詳細調整をリセット」：詳細 7 項目のみを既定値へ戻す（強度・ノイズ抑制・カーブは触らない）。
const detailsResetBtn = el('button', 'btn btn--ghost details-reset-btn');
detailsResetBtn.type = 'button';
detailsResetBtn.addEventListener('click', resetDetails);
append(accordion.body, detailsResetBtn);

const resetBtn = el('button', 'btn btn--ghost reset-btn');
resetBtn.type = 'button';
resetBtn.addEventListener('click', resetAdjustments);

append(controlsBlock, autoAccordion.element, curves.element, accordion.element, resetBtn);

// ---- 通知（トースト）・ヘルプ ----
// トーストはプレビューのバックエンド切替コールバックが参照するため先に生成する。
const toast = createToastHost();
const help = createHelpModal();
helpBtn.addEventListener('click', () => help.open());

// ---- プレビュー・書き出し ----
const preview = createPreview();
preview.element.classList.add('block-preview');
preview.onBackendChange((backend) => {
  if (backend === 'canvas2d') toast.show(t('warnCanvas2d'), 'warning');
});

const exportBar = createExportBar({
  onSizeChange: () => scheduleRecompute(),
  onDownload: () => void downloadCube(),
  onSavePng: () => void savePng(),
  onSaveResonite: () => void saveResonite(),
});
exportBar.element.classList.add('block-exportbar');

// ---- 全体組み立て ----
const main = el('main', 'app-main');
append(main, inputsBlock, controlsBlock, preview.element, exportBar.element);

append(appRoot, header, main, toast.element, help.element);

// ============================================================
// i18n テキスト適用
// ============================================================

function refreshStaticText(): void {
  document.title = t('appTitle');
  brandTitle.textContent = t('appTitle');
  brandTag.textContent = t('appTagline');
  langBtn.textContent = t('langToggle');
  langBtn.setAttribute('aria-label', t('langToggleAria'));
  helpBtn.setAttribute('aria-label', t('helpAria'));
  helpBtn.title = t('helpAria');
  sampleBtn.textContent = t('sampleButton');
  resetBtn.textContent = t('resetButton');
  detailsResetBtn.textContent = t('detailsResetButton');
  hintText.textContent = t('firstHint');
}
onLangChange(refreshStaticText);
refreshStaticText();

// ============================================================
// ヘルパー：スライダー生成・フォーマット
// ============================================================

function fmtSigned(v: number): string {
  const r = Math.round(v);
  return `${r > 0 ? '+' : ''}${r}`;
}

function makeParamSlider(
  labelKey: Parameters<typeof createSlider>[0]['labelKey'],
  tooltipKey: Parameters<typeof createSlider>[0]['tooltipKey'],
  min: number,
  max: number,
  step: number,
  defaultValue: number,
  format: (v: number) => string,
  assign: (v: number) => void,
): SliderHandle {
  return createSlider({
    labelKey,
    tooltipKey,
    min,
    max,
    step,
    value: defaultValue,
    defaultValue,
    format,
    onInput: (v) => {
      assign(v);
      scheduleRecompute();
    },
    onDragState: setDragState,
  });
}

function setDragState(dragging: boolean): void {
  state.activeDrags += dragging ? 1 : -1;
  if (state.activeDrags < 0) state.activeDrags = 0;
  if (!dragging && state.activeDrags === 0) {
    // ドラッグ確定時にフル解像度で描き直す（Canvas 2D の段階的レンダリング）。
    preview.render('full');
  }
}

// ============================================================
// 状態遷移・UI 有効化
// ============================================================

function bothLoaded(): boolean {
  return state.source != null && state.reference != null;
}

/**
 * ノイズ抑制スライダーの有効/無効を追従させる（§4.4・§6.0）。二段構え：
 * - source && reference が揃わない → 統計マッチが存在しないため理由 `needsReferenceReason` で無効
 * - 両方揃っていてもモード A（ナチュラル）は HM を使わないため理由付きで無効
 */
function updateNoiseSuppressionDisabled(): void {
  if (!bothLoaded()) {
    noiseSuppressionSlider.setDisabled(true, 'needsReferenceReason');
    return;
  }
  const modeDisabled = state.mode === 'A';
  noiseSuppressionSlider.setDisabled(modeDisabled, modeDisabled ? 'noiseSuppressionDisabledReason' : undefined);
}

function updateUiState(): void {
  const s = state.source != null; // 手動群のゲート（恒等基底の手動 LUT 作成でも操作可）
  const both = bothLoaded(); // 統計群のゲート（自動マッチ由来のパラメーター）

  // --- s ゲート: 手動 5 スライダー・カーブ・リセット・書き出し ---
  for (const sl of manualSliders) sl.setDisabled(!s);
  curves.setDisabled(!s);
  resetBtn.classList.toggle('is-disabled', !s);
  (resetBtn as HTMLButtonElement).disabled = !s;
  detailsResetBtn.classList.toggle('is-disabled', !s);
  (detailsResetBtn as HTMLButtonElement).disabled = !s;
  exportBar.setDisabled(!s || state.currentLut == null);

  // --- both ゲート＋理由 needsReferenceReason: モード・強度・スムージング・ブラック保護 ---
  const reason = both ? undefined : 'needsReferenceReason';
  modeSegment.setDisabled(!both, reason);
  strengthSlider.setDisabled(!both, reason);
  for (const sl of statSliders) sl.setDisabled(!both, reason);

  // ノイズ抑制は二段（参考なし → 理由付き無効／モード A → 別理由）。
  updateNoiseSuppressionDisabled();

  preview.setEnabled(s);

  // 誘導ハイライトとヒント（§6.2）。点滅は「Reference あり・Source なし」の Source 誘導のみ。
  dropSource.setGuiding(state.source == null && state.reference != null);
  dropReference.setGuiding(false); // Reference の点滅誘導は廃止
  dropReference.setHint(state.source != null && state.reference == null ? 'referenceOptionalHint' : null);
}

// ============================================================
// 画像ロード
// ============================================================

type Role = 'source' | 'reference';

async function handleFile(role: Role, file: File | Blob | string): Promise<void> {
  // 同一 role への連続投入で、遅れて解決した古いデコードが後勝ちしないよう
  // 世代を管理する（開始時に採番し、完了時に最新か確認）。
  const generation = ++state.loadGeneration[role];
  try {
    const loaded = await loadImage(file);
    if (generation !== state.loadGeneration[role]) {
      loaded.dispose(); // 追い越されたので静かに破棄
      return;
    }
    setImage(role, loaded);
  } catch (err) {
    if (generation !== state.loadGeneration[role]) return; // 古い失敗は無視
    if (err instanceof ImageLoadError && err.kind === 'unsupported-format') {
      toast.show(t('errUnsupported'), 'error');
    } else if (typeof file === 'string') {
      toast.show(t('errSample'), 'error');
    } else {
      toast.show(t('errDecode'), 'error');
    }
    // 直前の状態を維持（§6.2）。
  }
}

function setImage(role: Role, loaded: LoadedImage): void {
  const prev = state[role];
  if (prev) prev.dispose(); // 旧リソース解放（§4.1）

  state[role] = loaded;
  if (role === 'source') {
    dropSource.setThumbnail(loaded.previewBitmap);
    preview.setSourceBitmap(loaded.previewBitmap);
  } else {
    dropReference.setThumbnail(loaded.previewBitmap);
    preview.setReferenceBitmap(loaded.previewBitmap);
    // Reference 投入（未投入→投入の遷移）で「自動調整」アコーディオンを自動オープンする（設計確定・§6.2）。
    // それ以外のタイミング（既に投入済みへの差し替え等）では自動で開閉しない。
    if (prev == null) autoAccordion.setOpen(true);
  }
  updateUiState();
  scheduleRecompute();
}

/**
 * 画像を削除して該当 role を空状態へ戻す（×ボタンから呼ぶ・§4.1）。
 * 進行中デコードの後勝ちを防ぐため世代を進め、source 削除時は recompute が
 * 早期 return する前に LUT を明示クリアして残留を防ぐ。
 */
function clearImage(role: Role): void {
  ++state.loadGeneration[role]; // 進行中デコードを後勝ち無効化
  const prev = state[role];
  state[role]?.dispose();
  state[role] = null;
  if (role === 'source') {
    dropSource.setThumbnail(null);
    preview.setSourceBitmap(null);
    // recompute は !src で早期 return するため、ここで消さないと LUT が残留する。
    state.currentLut = null;
    state.currentLutSize = 0;
  } else {
    dropReference.setThumbnail(null);
    preview.setReferenceBitmap(null);
    // Reference 削除（投入→未投入の遷移）で「自動調整」アコーディオンを自動クローズする（設計確定・§6.2）。
    if (prev != null) autoAccordion.setOpen(false);
  }
  updateUiState();
  scheduleRecompute();
}

async function loadSamples(): Promise<void> {
  const base = import.meta.env.BASE_URL;
  await Promise.all([
    handleFile('source', `${base}sample-source.webp`),
    handleFile('reference', `${base}sample-reference.webp`),
  ]);
}

// ============================================================
// 再計算（自動マッチ）フロー
// ============================================================

function buildOptions(): GenerateLutOptions {
  return {
    mode: state.mode,
    size: exportBar.getSize(),
    strength: state.strength,
    smoothing: state.smoothing,
    noiseSuppression: state.noiseSuppression,
    curves: curves.getEdits(),
    manual: {
      ...NEUTRAL_ADJUSTMENTS,
      exposure: state.exposure,
      contrast: state.contrast,
      saturation: state.saturation,
      temperature: state.temperature,
      tint: state.tint,
    },
    sample: {
      alphaThreshold: ALPHA_THRESHOLD,
      // UI の blackProtection は知覚（sRGB）輝度%。コア API はリニア輝度で比較するため、
      // ここ（UI 境界）で sRGB→リニアに変換して渡す（リニア 0.05 は知覚 ≒24.5% に相当し桁違い）。
      blackThreshold: srgbToLinear(state.blackProtection / 100),
    },
  };
}

/** ImageData のピクセルを転送用に複製する（元は再計算で再利用するため neuter しない）。 */
function copyPixels(data: ImageData): GenerateLutRequestPayload['source'] {
  return {
    buffer: data.data.slice().buffer,
    width: data.width,
    height: data.height,
  };
}

async function recompute(): Promise<void> {
  const src = state.source;
  if (!src) return;
  const ref = state.reference;

  preview.setComputing(true, 0.05);
  const payload: GenerateLutRequestPayload = {
    source: copyPixels(src.analysisData),
    // reference 未投入時は恒等基底の手動 LUT を生成する（reference は省略）。
    reference: ref ? copyPixels(ref.analysisData) : undefined,
    options: buildOptions(),
  };

  try {
    const result = await worker.generateLut(payload, (_phase, ratio) => {
      preview.setComputing(true, ratio);
    });
    state.currentLut = result.lut;
    state.currentLutSize = result.size;
    preview.setLut(result.lut, result.size);
    // カーブパネルへ最新の実効カーブ F と Source/結果ヒストグラムを差し込む（supersede 破棄経路では
    // 先に SupersededError で return するため到達しない）。
    curves.setBaseCurves(result.effectiveCurves, CURVE_BINS);
    curves.setHistograms(result.histSource, result.histResult, HIST_BINS);
    preview.render(state.activeDrags > 0 ? 'draft' : 'full');
    preview.setComputing(false);
    exportBar.setDisabled(false);
    if (result.fallback) toast.show(t('warnFallback'), 'warning');
  } catch (err) {
    if (err instanceof SupersededError) return; // 後続に置き換え（オーバーレイは後続が管理）
    preview.setComputing(false);
    toast.show(t('errGenerate'), 'error');
  }
}

const scheduleRecompute = debounce(() => void recompute(), RECOMPUTE_DEBOUNCE_MS);

// ============================================================
// 書き出し
// ============================================================

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = el('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // click 後すぐ revoke するとブラウザによっては DL が中断されるため遅延解放。
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function downloadCube(): Promise<void> {
  const lut = state.currentLut;
  if (!lut) return;
  exportBar.setBusy(true);
  const filename = exportBar.getFileName();
  const title = filename.replace(/\.cube$/i, '');
  try {
    // lut.slice() で複製を渡す（serializeCube は buffer を転送＝neuter するため）。
    const text = await worker.serializeCube(lut.slice(), state.currentLutSize, title);
    triggerDownload(new Blob([text], { type: 'text/plain' }), filename);
  } catch (err) {
    if (!(err instanceof SupersededError)) toast.show(t('errGenerate'), 'error');
  } finally {
    exportBar.setBusy(false);
  }
}

let savingPng = false;

async function savePng(): Promise<void> {
  const lut = state.currentLut;
  const src = state.source;
  if (!lut || !src) return;
  if (savingPng) return; // 連打による多重実行を防止（同期の重い全画素トリリニア）。
  savingPng = true;
  exportBar.setBusy(true);
  try {
    const blob = await renderResultPng(src.previewBitmap, lut, state.currentLutSize);
    const filename = exportBar.getFileName().replace(/\.cube$/i, '.png');
    triggerDownload(blob, filename);
  } catch {
    toast.show(t('errGenerate'), 'error');
  } finally {
    savingPng = false;
    exportBar.setBusy(false);
  }
}

// ---- Resonite パッケージ書き出し（§4.6・§13） ----

/** メタデータ（サムネイル .bitmap）のファイル名（テンプレート固定）。 */
const RESONITE_METADATA_NAME =
  'a36499239050e1cf138b00b1fac4ef15b1b567d43e01e0c8cf4dcfbce22681f7.bitmap';

interface ResoniteTemplate {
  recordJson: string;
  frdtDecoded: Uint8Array;
  assets: Array<{ hash: string; data: Uint8Array }>;
  metadataName: string;
  metadataData: Uint8Array;
}

/** 一度フェッチしたテンプレート資材のメモリキャッシュ（2 回目以降は再利用）。 */
let resoniteTemplateCache: ResoniteTemplate | null = null;
let savingResonite = false;

/** URL からバイト列を取得する（非 2xx は例外）。 */
async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch failed: ${url} (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

/** public/resonite-template/ からテンプレート資材一式を読み込む（キャッシュ付き）。 */
async function loadResoniteTemplate(): Promise<ResoniteTemplate> {
  if (resoniteTemplateCache) return resoniteTemplateCache;
  const dir = `${import.meta.env.BASE_URL}resonite-template/`;
  const recordRes = await fetch(`${dir}template.record`);
  if (!recordRes.ok) throw new Error(`fetch failed: template.record (${recordRes.status})`);
  const recordJson = await recordRes.text();
  // 8 テンプレアセットのハッシュ名は manifest（9 件）から旧 LUT ハッシュを除いて導出する。
  const manifest = (JSON.parse(recordJson) as { assetManifest: Array<{ hash: string }> })
    .assetManifest;
  const assetHashes = manifest.map((e) => e.hash).filter((h) => h !== OLD_LUT_HASH);
  const [frdtDecoded, metadataData, ...assetDatas] = await Promise.all([
    fetchBytes(`${dir}frdt-decoded.bin`),
    fetchBytes(`${dir}metadata/${RESONITE_METADATA_NAME}`),
    ...assetHashes.map((h) => fetchBytes(`${dir}assets/${h}`)),
  ]);
  const assets = assetHashes.map((hash, i) => ({ hash, data: assetDatas[i] }));
  resoniteTemplateCache = {
    recordJson,
    frdtDecoded,
    assets,
    metadataName: RESONITE_METADATA_NAME,
    metadataData,
  };
  return resoniteTemplateCache;
}

async function saveResonite(): Promise<void> {
  const lut = state.currentLut;
  if (!lut) return;
  if (savingResonite) return; // 連打・多重フェッチ防止。
  savingResonite = true;
  exportBar.setBusy(true, 'resonite');
  const base = exportBar.getFileName().replace(/\.cube$/i, '');
  const filename = `${base}.resonitepackage`;
  try {
    const template = await loadResoniteTemplate();
    // lut.slice() で複製を渡す（現在の LUT はプレビュー等が参照中のため）。
    const pkg = await buildResonitePackage({
      lut: lut.slice(),
      size: state.currentLutSize,
      name: base,
      templateRecordJson: template.recordJson,
      frdtDecoded: template.frdtDecoded,
      assets: template.assets,
      metadataName: template.metadataName,
      metadataData: template.metadataData,
    });
    // SharedArrayBuffer は不使用（§3）のため BlobPart へ narrow。
    triggerDownload(new Blob([pkg as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' }), filename);
  } catch {
    toast.show(t('errResoniteExport'), 'error');
  } finally {
    savingResonite = false;
    exportBar.setBusy(false, 'resonite');
  }
}

// ============================================================
// リセット（3 段階のスコープ・§4.4/§6.2）
// ============================================================

/**
 * 詳細調整アコーディオンの 7 項目（スムージング/露出/コントラスト/彩度/色温度/Tint/ブラック保護）
 * のみを既定値へ戻す。強度・ノイズ抑制・カーブは対象外。resetAdjustments と共通化（DRY）。
 * silent（setValue の第 2 引数）で個々の onInput 発火を抑え、呼び出し側で一度だけ scheduleRecompute する。
 */
function resetDetailSliders(): void {
  for (const { slider, key } of DETAIL_SLIDERS) {
    state[key] = DEFAULTS[key];
    slider.setValue(DEFAULTS[key], true);
  }
}

/** 「詳細調整をリセット」：詳細 7 項目のみ（強度・ノイズ抑制・カーブは維持）。 */
function resetDetails(): void {
  resetDetailSliders();
  scheduleRecompute();
}

/** 「すべてリセット」：強度・ノイズ抑制・詳細 7 項目・カーブ編集をまとめて初期化（自動マッチ結果は保持）。 */
function resetAdjustments(): void {
  state.strength = DEFAULTS.strength;
  strengthSlider.setValue(DEFAULTS.strength, true);
  state.noiseSuppression = DEFAULTS.noiseSuppression;
  noiseSuppressionSlider.setValue(DEFAULTS.noiseSuppression, true);
  resetDetailSliders();
  // カーブ編集も破棄する。silent で onChange を発火させず、末尾の単一 scheduleRecompute に集約する
  // （二重再計算を防止）。
  curves.reset({ silent: true });

  scheduleRecompute();
}

// ============================================================
// ライフサイクル
// ============================================================

// リサイズ追従（プレビューのバッキングストア・フィット再計算）。
let resizeRaf = 0;
window.addEventListener('resize', () => {
  if (resizeRaf) cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(() => {
    resizeRaf = 0;
    preview.resize();
  });
});

updateUiState();
// レイアウト確定後にプレビューのバッキングストアを合わせる。
requestAnimationFrame(() => preview.resize());
