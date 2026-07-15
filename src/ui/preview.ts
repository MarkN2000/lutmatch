/**
 * プレビュー領域（§4.5 / §6.3）。
 *
 * `createPreviewRenderer`（WebGL2 / Canvas2D）をラップし、以下を担う：
 * - 表示タブ（元画像 / 適用後 / 比較〔既定〕）
 * - 比較スライダー（デスクトップ＝どこでもドラッグ＋ハンドル、モバイル＝ハンドルのみ、←→キー）
 * - 参考画像サムネイル小窓（タップで一時拡大）
 * - 画像は常にステージへフィット表示（拡大縮小・パン操作はなし）
 * - 計算中スケルトン＋進捗、空状態ヒント
 */

import { append, el, isCoarsePointer } from './dom.ts';
import { attachFileDrop, createHiddenFileInput } from './fileInput.ts';
import { onLangChange, t } from '../i18n/index.ts';
import {
  createPreviewRenderer,
  type PreviewBackend,
  type PreviewRenderer,
  type PreviewViewMode,
  type RenderQuality,
} from '../gl/preview.ts';
import { clampSplit, computeFitTransform, type ViewTransform } from '../gl/preview-math.ts';

export interface PreviewHandle {
  element: HTMLElement;
  setSourceBitmap(bitmap: ImageBitmap | null): void;
  setReferenceBitmap(bitmap: ImageBitmap | null): void;
  setLut(lut: Float32Array, size: number): void;
  render(quality?: RenderQuality): void;
  resize(): void;
  setComputing(computing: boolean, ratio?: number): void;
  setEnabled(enabled: boolean): void;
  /** 空状態ガイド（Source ドロップゾーン）の点滅誘導 ON/OFF（§6.2-3 の Reference のみ投入時）。 */
  setSourceGuiding(guiding: boolean): void;
  onBackendChange(cb: (backend: PreviewBackend) => void): void;
}

/**
 * プレビューが Source の入力口を兼ねるためのコールバック（§4.1 / §6.1）。
 * - onSourceFile: 空状態のクリック選択・常時 D&D・「差し替え」ボタンからのファイル投入
 * - onSample: 空状態の「サンプル画像で試す」リンク
 * - onRemoveSource: タブバーの削除（×）ボタン
 */
export interface PreviewOptions {
  onSourceFile: (file: File) => void;
  onSample: () => void;
  onRemoveSource: () => void;
}

interface TabDef {
  mode: PreviewViewMode;
  key: 'tabOriginal' | 'tabResult' | 'tabCompare';
}

const TABS: TabDef[] = [
  { mode: 'original', key: 'tabOriginal' },
  { mode: 'result', key: 'tabResult' },
  { mode: 'compare', key: 'tabCompare' },
];

export function createPreview(options: PreviewOptions): PreviewHandle {
  const { onSourceFile, onSample, onRemoveSource } = options;
  const root = el('div', 'preview');

  // ---- タブ ----
  const tabs = el('div', 'preview__tabs');
  tabs.setAttribute('role', 'tablist');
  let viewMode: PreviewViewMode = 'compare';
  const tabButtons = new Map<PreviewViewMode, HTMLButtonElement>();

  // タブバー右端の Source 操作（差し替え / 削除）。Source 投入時のみ表示（§4.1 / §6.1）。
  const tabActions = el('div', 'preview__tab-actions');
  tabActions.hidden = true;
  const replaceBtn = el('button', 'preview__action');
  replaceBtn.type = 'button';
  const removeBtn = el('button', 'preview__action preview__action--remove');
  removeBtn.type = 'button';
  removeBtn.textContent = '×';
  append(tabActions, replaceBtn, removeBtn);

  // Source 投入用の隠しファイル入力（空状態のクリック・「差し替え」ボタン共通）。
  const fileInput = createHiddenFileInput(onSourceFile);
  const pickSource = (): void => fileInput.open();

  // ---- ステージ ----
  const stage = el('div', 'preview__stage');
  const canvas = el('canvas', 'preview__canvas');
  const refThumb = el('div', 'preview__ref-thumb');
  refThumb.hidden = true;
  const refCanvas = el('canvas', 'preview__ref-canvas');
  append(refThumb, refCanvas);

  const handle = el('button', 'preview__handle');
  handle.type = 'button';
  handle.hidden = true;

  const overlay = el('div', 'preview__overlay');
  overlay.hidden = true;
  const skeleton = el('div', 'preview__skeleton');
  const progressBar = el('div', 'preview__progress');
  const progressFill = el('div', 'preview__progress-fill');
  const progressText = el('div', 'preview__progress-text');
  append(progressBar, progressFill);
  append(overlay, skeleton, progressBar, progressText);

  // 空状態＝Source ドロップゾーン（ガイド文言＝実ボタン＋対応形式＋サンプルリンク・§4.1 / §6.2）。
  // emptyHint 自体は装飾コンテナ。操作は内部の実 <button> がネイティブに担う
  // （キーボード＝Enter/Space、フォーカスもボタン側）。
  const emptyHint = el('div', 'preview__empty');
  const emptyInner = el('div', 'preview__empty-inner');
  // ガイド文言そのものを実ボタンにし、ネイティブのクリック/Enter/Space でファイル選択を開く。
  const emptyPick = el('button', 'preview__empty-pick');
  emptyPick.type = 'button';
  const emptyFormats = el('div', 'preview__empty-formats');
  const sampleLink = el('button', 'sample-link preview__sample-link');
  sampleLink.type = 'button';
  append(emptyInner, emptyPick, emptyFormats, sampleLink);
  append(emptyHint, emptyInner);

  emptyPick.addEventListener('click', pickSource);

  // 背景（ボタン以外）クリックでもファイル選択を開く。ボタン由来のクリックは
  // 各ボタン自身のハンドラーへ委ね、ここでは二重発火させない。
  emptyHint.addEventListener('click', (e) => {
    if ((e.target as Element).closest('button')) return;
    pickSource();
  });
  sampleLink.addEventListener('click', (e) => {
    e.stopPropagation();
    onSample();
  });

  append(stage, canvas, refThumb, handle, overlay, emptyHint);
  append(root, tabs, stage, fileInput.element);

  const renderer: PreviewRenderer = createPreviewRenderer(canvas);
  renderer.setViewMode(viewMode);

  // ---- 状態 ----
  let sourceBitmap: ImageBitmap | null = null;
  let referenceBitmap: ImageBitmap | null = null;
  // 空状態ガイド文言の誘導 ON/OFF（言語切替でも正しい方を表示するため保持）。
  let sourceGuiding = false;
  let split = 0.5;
  let transform: ViewTransform = { scale: 1, offsetX: 0, offsetY: 0 };

  const stageSize = (): { w: number; h: number } => ({
    w: stage.clientWidth || 1,
    h: stage.clientHeight || 1,
  });

  const applyTransform = (quality: RenderQuality = 'full'): void => {
    renderer.setViewTransform(transform.scale, transform.offsetX, transform.offsetY);
    renderer.render(quality);
  };

  // 画像は常にステージへフィット表示する（拡大縮小・パンは行わない）。
  const fitToStage = (): void => {
    if (!sourceBitmap) return;
    const { w, h } = stageSize();
    transform = computeFitTransform(sourceBitmap.width, sourceBitmap.height, w, h);
    applyTransform();
  };

  const updateHandlePos = (): void => {
    handle.style.left = `${split * 100}%`;
  };

  const setSplit = (x: number, quality: RenderQuality = 'full'): void => {
    split = clampSplit(x);
    renderer.setSplit(split);
    updateHandlePos();
    renderer.render(quality);
  };

  // ---- タブ切替 ----
  const syncTabs = (): void => {
    for (const [mode, btn] of tabButtons) {
      const active = mode === viewMode;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', String(active));
      btn.tabIndex = active ? 0 : -1;
    }
    handle.hidden = viewMode !== 'compare' || !sourceBitmap;
    updateHandlePos();
  };

  const setViewMode = (mode: PreviewViewMode): void => {
    viewMode = mode;
    renderer.setViewMode(mode);
    syncTabs();
    renderer.render('full');
  };

  for (const def of TABS) {
    const btn = el('button', 'preview__tab');
    btn.type = 'button';
    btn.setAttribute('role', 'tab');
    btn.addEventListener('click', () => setViewMode(def.mode));
    tabButtons.set(def.mode, btn);
    append(tabs, btn);
  }
  append(tabs, tabActions);

  replaceBtn.addEventListener('click', pickSource);
  removeBtn.addEventListener('click', onRemoveSource);

  // ---- Source 用の常時ドラッグ＆ドロップ（投入後も差し替え可・§4.1）----
  // クリックでのファイル選択は誤操作防止のため空状態限定（emptyHint のみ）。D&D は常時受け付ける。
  attachFileDrop(stage, onSourceFile);

  // ---- 比較スライダーのドラッグ ----
  const coarse = isCoarsePointer();

  const splitFromClientX = (clientX: number): number => {
    const rect = stage.getBoundingClientRect();
    return (clientX - rect.left) / (rect.width || 1);
  };

  // ハンドルドラッグ（全プラットフォーム共通）。
  let handleDragging = false;
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    handleDragging = true;
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove', (e) => {
    if (!handleDragging) return;
    setSplit(splitFromClientX(e.clientX), 'draft');
  });
  const endHandleDrag = (e: PointerEvent): void => {
    if (!handleDragging) return;
    handleDragging = false;
    try {
      handle.releasePointerCapture(e.pointerId);
    } catch {
      /* すでに解放済み */
    }
    setSplit(split, 'full');
  };
  handle.addEventListener('pointerup', endHandleDrag);
  handle.addEventListener('pointercancel', endHandleDrag);

  // キーボード（←→）。
  handle.addEventListener('keydown', (e) => {
    const stepAmt = e.shiftKey ? 0.1 : 0.02;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      setSplit(split - stepAmt);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      setSplit(split + stepAmt);
    }
  });

  // ---- ステージのポインタ操作（デスクトップの比較ドラッグ）----
  // モバイル（coarse pointer）はハンドルドラッグのみで動作させる（縦スクロールとの競合回避）。
  let compareDragging = false;

  stage.addEventListener('pointerdown', (e) => {
    if (e.target === handle) return;
    // 空状態はステージ全体が Source ドロップゾーンなので、比較ドラッグを起動しない
    // （pointer capture が emptyHint・サンプルリンクへのクリックを奪うのを防ぐ）。
    if (viewMode !== 'compare' || coarse || !sourceBitmap) return;
    compareDragging = true;
    stage.setPointerCapture(e.pointerId);
    setSplit(splitFromClientX(e.clientX), 'draft');
  });

  stage.addEventListener('pointermove', (e) => {
    if (!compareDragging) return;
    setSplit(splitFromClientX(e.clientX), 'draft');
  });

  const endStagePointer = (e: PointerEvent): void => {
    if (!compareDragging) return;
    compareDragging = false;
    try {
      stage.releasePointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
    setSplit(split, 'full');
  };
  stage.addEventListener('pointerup', endStagePointer);
  stage.addEventListener('pointercancel', endStagePointer);

  // ---- 参考サムネイル ----
  refThumb.addEventListener('click', () => refThumb.classList.toggle('is-expanded'));

  const drawReference = (): void => {
    if (!referenceBitmap) {
      refThumb.hidden = true;
      return;
    }
    const maxEdge = 96;
    const scale = Math.min(1, maxEdge / Math.max(referenceBitmap.width, referenceBitmap.height));
    refCanvas.width = Math.max(1, Math.round(referenceBitmap.width * scale));
    refCanvas.height = Math.max(1, Math.round(referenceBitmap.height * scale));
    const ctx = refCanvas.getContext('2d');
    if (ctx) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(referenceBitmap, 0, 0, refCanvas.width, refCanvas.height);
    }
    refThumb.hidden = false;
  };

  // ---- i18n ----
  const refreshText = (): void => {
    for (const def of TABS) {
      const btn = tabButtons.get(def.mode);
      if (btn) btn.textContent = t(def.key);
    }
    handle.setAttribute('aria-label', t('compareHandleAria'));
    emptyPick.textContent = t(sourceGuiding ? 'guideSource' : 'dropHint');
    emptyPick.setAttribute('aria-label', t('sourceTitle'));
    emptyFormats.textContent = t('dropFormats');
    sampleLink.textContent = t('sampleButton');
    replaceBtn.textContent = t('replaceSourceButton');
    replaceBtn.setAttribute('aria-label', t('replaceSourceAria'));
    removeBtn.setAttribute('aria-label', t('removeImageAria'));
    refCanvas.setAttribute('aria-label', t('referenceThumbAlt'));
    refThumb.title = t('referenceThumbAlt');
  };
  onLangChange(refreshText);
  refreshText();
  syncTabs();

  return {
    element: root,
    setSourceBitmap(bitmap): void {
      sourceBitmap = bitmap;
      renderer.setImage(bitmap);
      emptyHint.hidden = bitmap != null;
      tabActions.hidden = bitmap == null; // 差し替え/削除は Source 投入時のみ
      if (bitmap) {
        fitToStage();
      } else {
        renderer.render('full');
      }
      syncTabs();
    },
    setReferenceBitmap(bitmap): void {
      referenceBitmap = bitmap;
      drawReference();
    },
    setLut(lut, size): void {
      renderer.setLut(lut, size);
      renderer.render('full');
    },
    render(quality): void {
      renderer.render(quality);
    },
    resize(): void {
      renderer.resize();
      fitToStage();
    },
    setComputing(computing, ratio = 0): void {
      overlay.hidden = !computing;
      progressFill.style.width = `${Math.round(ratio * 100)}%`;
      progressText.textContent = computing ? t('computing') : '';
    },
    setEnabled(enabled): void {
      // 操作できないのはタブ列のみ。空状態 CTA を減光対象から外すため、root ではなく
      // タブ列へ直接クラスを当てる（CSS の選択子ではなくコード構造で保証する）。
      tabs.classList.toggle('is-disabled', !enabled);
    },
    setSourceGuiding(guiding): void {
      sourceGuiding = guiding;
      emptyHint.classList.toggle('is-guiding', guiding);
      emptyPick.textContent = t(guiding ? 'guideSource' : 'dropHint');
    },
    onBackendChange(cb): void {
      renderer.onBackendChange(cb);
    },
  };
}
