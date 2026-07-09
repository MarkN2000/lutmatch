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
import { createPreview } from './ui/preview.ts';
import { createExportBar } from './ui/exportbar.ts';
import { createToastHost } from './ui/toast.ts';
import { createHelpModal } from './ui/help.ts';
import { renderResultPng } from './ui/export-png.ts';

import { loadImage, ImageLoadError, type LoadedImage } from './io/image.ts';
import { MatchWorkerClient, SupersededError } from './worker/client.ts';
import type { GenerateLutRequestPayload } from './worker/protocol.ts';
import { NEUTRAL_ADJUSTMENTS, type GenerateLutOptions, type MatchMode } from './core/index.ts';

// ============================================================
// 定数・既定値（§4.4）
// ============================================================

const DEFAULTS: Record<string, number> = {
  strength: 85,
  smoothing: 20,
  exposure: 0,
  contrast: 0,
  saturation: 0,
  temperature: 0,
  tint: 0,
  blackProtection: 5, // %（0–20）。sample.blackThreshold へは /100 で渡す
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
const dropSource: DropzoneHandle = createDropzone('source', (f) => handleFile('source', f));
const dropReference: DropzoneHandle = createDropzone('reference', (f) => handleFile('reference', f));
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

const modeSection = el('div', 'control-group');
const modeLabel = el('div', 'control-group__label');
const modeSegment = createModeSegment(state.mode, (mode) => {
  state.mode = mode;
  scheduleRecompute();
});
append(modeSection, modeLabel, modeSegment.element);

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

const accordion = createAccordion('detailsTitle');

// 詳細 7 項目（§4.4）。
const smoothingSlider = makeParamSlider('smoothingLabel', 'smoothingTooltip', 0, 100, 1, DEFAULTS.smoothing, (v) => `${Math.round(v)}`, (v) => (state.smoothing = v));
const exposureSlider = makeParamSlider('exposureLabel', 'exposureTooltip', -2, 2, 0.05, DEFAULTS.exposure, (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)} EV`, (v) => (state.exposure = v));
const contrastSlider = makeParamSlider('contrastLabel', 'contrastTooltip', -50, 50, 1, DEFAULTS.contrast, fmtSigned, (v) => (state.contrast = v));
const saturationSlider = makeParamSlider('saturationLabel', 'saturationTooltip', -100, 100, 1, DEFAULTS.saturation, fmtSigned, (v) => (state.saturation = v));
const temperatureSlider = makeParamSlider('temperatureLabel', 'temperatureTooltip', -100, 100, 1, DEFAULTS.temperature, fmtSigned, (v) => (state.temperature = v));
const tintSlider = makeParamSlider('tintLabel', 'tintTooltip', -100, 100, 1, DEFAULTS.tint, fmtSigned, (v) => (state.tint = v));
const blackSlider = makeParamSlider('blackLabel', 'blackTooltip', 0, 20, 1, DEFAULTS.blackProtection, (v) => `${Math.round(v)}%`, (v) => (state.blackProtection = v));

const detailSliders: SliderHandle[] = [
  smoothingSlider,
  exposureSlider,
  contrastSlider,
  saturationSlider,
  temperatureSlider,
  tintSlider,
  blackSlider,
];
for (const s of detailSliders) append(accordion.body, s.element);

const resetBtn = el('button', 'btn btn--ghost reset-btn');
resetBtn.type = 'button';
resetBtn.addEventListener('click', resetAdjustments);

append(controlsBlock, modeSection, strengthSlider.element, accordion.element, resetBtn);

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
  modeLabel.textContent = t('modeLabel');
  sampleBtn.textContent = t('sampleButton');
  resetBtn.textContent = t('resetButton');
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

function updateUiState(): void {
  const both = bothLoaded();
  const enabled = both;
  modeSegment.setDisabled(!enabled);
  strengthSlider.setDisabled(!enabled);
  for (const s of detailSliders) s.setDisabled(!enabled);
  resetBtn.classList.toggle('is-disabled', !enabled);
  (resetBtn as HTMLButtonElement).disabled = !enabled;
  exportBar.setDisabled(!enabled || state.currentLut == null);
  preview.setEnabled(state.source != null);

  // 誘導ハイライト（片方のみ投入）。
  dropSource.setGuiding(state.source == null && state.reference != null);
  dropReference.setGuiding(state.reference == null && state.source != null);
}

// ============================================================
// 画像ロード
// ============================================================

type Role = 'source' | 'reference';

async function handleFile(role: Role, file: File | Blob | string): Promise<void> {
  try {
    const loaded = await loadImage(file);
    setImage(role, loaded);
  } catch (err) {
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
      blackThreshold: state.blackProtection / 100,
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
  const ref = state.reference;
  if (!src || !ref) return;

  preview.setComputing(true, 0.05);
  const payload: GenerateLutRequestPayload = {
    source: copyPixels(src.analysisData),
    reference: copyPixels(ref.analysisData),
    options: buildOptions(),
  };

  try {
    const result = await worker.generateLut(payload, (_phase, ratio) => {
      preview.setComputing(true, ratio);
    });
    state.currentLut = result.lut;
    state.currentLutSize = result.size;
    preview.setLut(result.lut, result.size);
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

async function savePng(): Promise<void> {
  const lut = state.currentLut;
  const src = state.source;
  if (!lut || !src) return;
  try {
    const blob = await renderResultPng(src.previewBitmap, lut, state.currentLutSize);
    const filename = exportBar.getFileName().replace(/\.cube$/i, '.png');
    triggerDownload(blob, filename);
  } catch {
    toast.show(t('errGenerate'), 'error');
  }
}

// ============================================================
// リセット（手動調整のみ・§4.4）
// ============================================================

function resetAdjustments(): void {
  state.strength = DEFAULTS.strength;
  state.smoothing = DEFAULTS.smoothing;
  state.exposure = DEFAULTS.exposure;
  state.contrast = DEFAULTS.contrast;
  state.saturation = DEFAULTS.saturation;
  state.temperature = DEFAULTS.temperature;
  state.tint = DEFAULTS.tint;
  state.blackProtection = DEFAULTS.blackProtection;

  strengthSlider.setValue(DEFAULTS.strength, true);
  smoothingSlider.setValue(DEFAULTS.smoothing, true);
  exposureSlider.setValue(DEFAULTS.exposure, true);
  contrastSlider.setValue(DEFAULTS.contrast, true);
  saturationSlider.setValue(DEFAULTS.saturation, true);
  temperatureSlider.setValue(DEFAULTS.temperature, true);
  tintSlider.setValue(DEFAULTS.tint, true);
  blackSlider.setValue(DEFAULTS.blackProtection, true);

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
