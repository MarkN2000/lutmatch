/**
 * カーブエディタ UI パネル（§5.7 / §6.1）。
 *
 * 「カーブ」独立アコーディオン（既定閉）の中に、チャンネルタブ（マスター/R/G/B）と
 * 単一の canvas を持ち、その上で以下を描画・編集する：
 *
 * - 背景：枠＋1/4 グリッド、選択チャンネルの Source ヒストグラム（半透明塗り）と
 *   結果ヒストグラム（輪郭線）、恒等対角線
 * - 基底カーブ F（実効カーブ・減光実線。Source が薄い＝疎データ域はさらに減光）
 * - 編集後カーブ F(x) + evalResidual(points, x)（チャンネル色の明色実線・表示は [0,1] クリップ）
 * - コントロールポイント（端点 2 常設＋内部点。ドラッグで dy 編集・ダブルタップで削除）
 *
 * 編集は「基底カーブからの残差 dy」として core/curve.ts の純粋関数で保持・評価する。
 * canvas 描画は rAF で間引き、devicePixelRatio に追従する（gl/preview-math.ts を再利用）。
 */

import { append, el, isCoarsePointer } from './dom.ts';
import { createAccordion } from './accordion.ts';
import { onLangChange, t } from '../i18n/index.ts';
import {
  clampDevicePixelRatio,
  backingStoreSize,
  MAX_DEVICE_PIXEL_RATIO,
} from '../gl/preview-math.ts';
import {
  evalResidual,
  sampleResidualToGrid,
  MAX_CONTROL_POINTS,
  CURVE_MIN_X_GAP,
  type ControlPoint,
  type CurveEdits,
} from '../core/curve.ts';

/** カーブパネルの公開ハンドル。 */
export interface CurvesHandle {
  /** アコーディオン込みのルート要素。 */
  element: HTMLElement;
  /** 現在の編集（防御的コピーを返す）。 */
  getEdits(): CurveEdits;
  /** Worker 結果の実効カーブ F [R|G|B|M]（4×bins）を差し込む。 */
  setBaseCurves(effective: Float32Array, bins: number): void;
  /** Source / 結果ヒストグラム [R|G|B|Y']（各 4×bins）を差し込む。 */
  setHistograms(source: Float32Array, result: Float32Array, bins: number): void;
  /** 編集が変わるたび（ドラッグ中の move ごとも含む）に発火。 */
  onChange(cb: () => void): void;
  /** ドラッグ開始/終了（pointerdown/up）を通知（main が setDragState に配線）。 */
  onDragState(cb: (dragging: boolean) => void): void;
  /** 全編集を破棄し自動マッチ状態へ戻す。silent なら onChange を発火しない。 */
  reset(opts?: { silent?: boolean }): void;
  /** 画像 2 枚が揃うまで無効化（薄く・pointer 操作無効）。 */
  setDisabled(disabled: boolean): void;
}

/** RGB カーブエディタのチャンネルキー（master/r/g/b。周期軸の hue/hueSat は別エディタ）。 */
type RgbCurveKey = 'master' | 'r' | 'g' | 'b';

/** 4 チャンネルの定義（タブ表示順）。block は [R|G|B|M]／[R|G|B|Y'] 連結配列のブロック番号。 */
interface ChannelDef {
  key: RgbCurveKey;
  /** タブ文言（master のみ i18n。R/G/B は字義通り）。 */
  label: string;
  i18n: boolean;
  /** 実効カーブ・ヒストグラム配列内のブロック番号（R=0/G=1/B=2/master=3）。 */
  block: number;
  /** 基底・編集後カーブの実線色。 */
  stroke: string;
  /** Source ヒストグラム塗り色（低アルファ）。 */
  fill: string;
  /** 結果ヒストグラム輪郭線色。 */
  outline: string;
}

const CHANNELS: ChannelDef[] = [
  {
    key: 'master',
    label: 'Master',
    i18n: true,
    block: 3,
    stroke: '#d7dade',
    fill: 'rgba(180, 185, 193, 0.16)',
    outline: 'rgba(200, 205, 213, 0.5)',
  },
  {
    key: 'r',
    label: 'R',
    i18n: false,
    block: 0,
    stroke: '#ef8b8b',
    fill: 'rgba(224, 96, 96, 0.16)',
    outline: 'rgba(236, 130, 130, 0.5)',
  },
  {
    key: 'g',
    label: 'G',
    i18n: false,
    block: 1,
    stroke: '#8bd39a',
    fill: 'rgba(96, 200, 120, 0.16)',
    outline: 'rgba(130, 214, 150, 0.5)',
  },
  {
    key: 'b',
    label: 'B',
    i18n: false,
    block: 2,
    stroke: '#8bb4ef',
    fill: 'rgba(96, 140, 224, 0.18)',
    outline: 'rgba(130, 170, 236, 0.5)',
  },
];

/** canvas の CSS 高さ（px 固定）。 */
const CANVAS_HEIGHT = 200;
/** プロット領域の内側余白（端点ハンドルがはみ出さないための余白）。 */
const PAD = 9;
/** ヒットテスト半径（CSS px）。 */
const HIT_RADIUS = 24;
/** 曲線近傍とみなす縦距離（CSS px、点の即時追加判定）。 */
const CURVE_NEAR = 20;
/** ダブルタップ判定の時間窓（ms）。 */
const DOUBLE_TAP_MS = 300;
/** 疎データ域とみなす Source ヒストグラム正規化度数のしきい値。 */
const SPARSE_THRESHOLD = 0.015;

/** チャンネル 1 本を「編集なし」の初期状態（端点のみ・dy=0）で作る。 */
function makeEmptyChannel(): ControlPoint[] {
  return [
    { x: 0, dy: 0 },
    { x: 1, dy: 0 },
  ];
}

/** 全チャンネルを初期状態にした CurveEdits を作る。 */
function makeEmptyEdits(): CurveEdits {
  return {
    master: makeEmptyChannel(),
    r: makeEmptyChannel(),
    g: makeEmptyChannel(),
    b: makeEmptyChannel(),
  };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function createCurves(): CurvesHandle {
  // ---- 状態 ----
  const edits = makeEmptyEdits();
  let selected = 0; // CHANNELS のインデックス（既定＝マスター）。
  let disabled = false;

  // Worker から差し込まれる実効カーブ／ヒストグラム（未設定時は恒等 F・ヒスト無し）。
  let baseCurve: Float32Array | null = null;
  let baseBins = 0;
  let histSource: Float32Array | null = null;
  let histResult: Float32Array | null = null;
  let histBins = 0;

  // 編集・ドラッグ通知のコールバック。
  const changeCbs: Array<() => void> = [];
  const dragCbs: Array<(dragging: boolean) => void> = [];
  const emitChange = (): void => {
    for (const cb of changeCbs) cb();
  };
  const emitDrag = (d: boolean): void => {
    for (const cb of dragCbs) cb(d);
  };

  // ---- DOM 構築 ----
  const accordion = createAccordion('curvesTitle');

  const tabRow = el('div', 'curves__tabs');
  tabRow.setAttribute('role', 'tablist');
  const tabButtons: HTMLButtonElement[] = [];

  const resetBtn = el('button', 'btn btn--ghost curves__reset');
  resetBtn.type = 'button';

  const head = el('div', 'curves__head');
  append(head, tabRow, resetBtn);

  const canvasHost = el('div', 'curves__canvas-host');
  const canvas = el('canvas', 'curves__canvas');
  canvas.style.touchAction = 'none';
  append(canvasHost, canvas);

  append(accordion.body, head, canvasHost);

  const ctx = canvas.getContext('2d');

  // ---- 座標変換（CSS px）----
  let cssW = 0;
  let cssH = 0;
  const plotW = (): number => Math.max(1, cssW - 2 * PAD);
  const plotH = (): number => Math.max(1, cssH - 2 * PAD);
  const gx = (x: number): number => PAD + x * plotW();
  const gy = (v: number): number => PAD + (1 - clamp01(v)) * plotH();
  const pxToX = (px: number): number => clamp01((px - PAD) / plotW());
  const pyToVal = (py: number): number => 1 - (py - PAD) / plotH();

  // ---- 基底カーブ F の評価 ----
  /** ブロック block の実効カーブを x で線形補間（未設定時は恒等 F(x)=x）。 */
  const baseAt = (block: number, x: number): number => {
    if (!baseCurve || baseBins <= 0) return x;
    const off = block * baseBins;
    // ビン中心は (i+0.5)/bins。連続ビン座標 c = x*bins − 0.5。
    const c = x * baseBins - 0.5;
    if (c <= 0) return baseCurve[off];
    if (c >= baseBins - 1) return baseCurve[off + baseBins - 1];
    const i = Math.floor(c);
    const f = c - i;
    return baseCurve[off + i] * (1 - f) + baseCurve[off + i + 1] * f;
  };

  /** ブロック block の Source ヒストグラム正規化度数を x で参照（未設定は 1＝密とみなす）。 */
  const sourceDensityAt = (block: number, x: number): number => {
    if (!histSource || histBins <= 0) return 1;
    let i = Math.floor(x * histBins);
    if (i < 0) i = 0;
    else if (i >= histBins) i = histBins - 1;
    return histSource[block * histBins + i];
  };

  // ---- 描画 ----
  let rafPending = false;
  const scheduleDraw = (): void => {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      draw();
    });
  };

  /** バッキングストア解像度を CSS サイズ・dpr に合わせて再構成する。 */
  const syncBacking = (): void => {
    cssW = canvasHost.clientWidth;
    cssH = CANVAS_HEIGHT;
    if (cssW <= 0) return; // 非表示（アコーディオン閉）中は描画しない。
    const dpr = clampDevicePixelRatio(
      typeof window !== 'undefined' ? window.devicePixelRatio : 1,
      MAX_DEVICE_PIXEL_RATIO,
    );
    const { width, height } = backingStoreSize(cssW, cssH, dpr);
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    canvas.style.height = `${cssH}px`;
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  const draw = (): void => {
    syncBacking();
    if (!ctx || cssW <= 0) return;
    const ch = CHANNELS[selected];
    ctx.clearRect(0, 0, cssW, cssH);

    // 1) 枠＋1/4 グリッド。
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.beginPath();
    for (let k = 1; k <= 3; k++) {
      const gxk = gx(k / 4);
      ctx.moveTo(gxk, gy(1));
      ctx.lineTo(gxk, gy(0));
      const gyk = gy(k / 4);
      ctx.moveTo(gx(0), gyk);
      ctx.lineTo(gx(1), gyk);
    }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.strokeRect(gx(0), gy(1), plotW(), plotH());

    // 2) Source ヒストグラム（半透明塗り・パネル高さいっぱいにスケール）。
    if (histSource && histBins > 0) {
      ctx.fillStyle = ch.fill;
      const off = ch.block * histBins;
      const base = gy(0);
      const w = plotW() / histBins;
      ctx.beginPath();
      for (let i = 0; i < histBins; i++) {
        const d = histSource[off + i];
        if (d <= 0) continue;
        const x0 = gx(i / histBins);
        ctx.rect(x0, gy(d), Math.max(1, w), base - gy(d));
      }
      ctx.fill();
    }

    // 3) 結果ヒストグラム（細い輪郭線）。
    if (histResult && histBins > 0) {
      ctx.strokeStyle = ch.outline;
      ctx.lineWidth = 1;
      const off = ch.block * histBins;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < histBins; i++) {
        const px = gx((i + 0.5) / histBins);
        const py = gy(histResult[off + i]);
        if (!started) {
          ctx.moveTo(px, py);
          started = true;
        } else {
          ctx.lineTo(px, py);
        }
      }
      ctx.stroke();
    }

    // 4) 恒等対角線（薄い点線）。
    ctx.save();
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(gx(0), gy(0));
    ctx.lineTo(gx(1), gy(1));
    ctx.stroke();
    ctx.restore();

    // サンプル本数（描画・残差評価を CSS 幅の 1/2 解像度で行う）。
    const nSamples = Math.max(2, Math.round(plotW() / 2));

    // 5) 基底カーブ F（減光実線。疎データ域はさらに減光）。
    ctx.lineWidth = 1.5;
    for (let i = 0; i < nSamples - 1; i++) {
      const x0 = i / (nSamples - 1);
      const x1 = (i + 1) / (nSamples - 1);
      const xm = (x0 + x1) / 2;
      const sparse = sourceDensityAt(ch.block, xm) < SPARSE_THRESHOLD;
      ctx.globalAlpha = sparse ? 0.16 : 0.42;
      ctx.strokeStyle = ch.stroke;
      ctx.beginPath();
      ctx.moveTo(gx(x0), gy(baseAt(ch.block, x0)));
      ctx.lineTo(gx(x1), gy(baseAt(ch.block, x1)));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // 6) 編集後カーブ F(x) + 残差（チャンネル色の明色実線・表示は [0,1] クリップ）。
    const points = edits[ch.key];
    const residual = sampleResidualToGrid(points, nSamples);
    ctx.strokeStyle = ch.stroke;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < nSamples; i++) {
      const x = i / (nSamples - 1);
      const py = gy(baseAt(ch.block, x) + residual[i]); // gy が [0,1] にクランプ。
      if (i === 0) ctx.moveTo(gx(x), py);
      else ctx.lineTo(gx(x), py);
    }
    ctx.stroke();

    // 7) コントロールポイント。
    const r = isCoarsePointer() ? 8 : 6;
    for (const p of points) {
      const px = gx(p.x);
      const py = gy(baseAt(ch.block, p.x) + p.dy);
      const active = p === dragPoint || p === hoverPoint;
      ctx.beginPath();
      ctx.arc(px, py, active ? r + 2 : r, 0, Math.PI * 2);
      ctx.fillStyle = active ? ch.stroke : 'rgba(20, 22, 26, 0.9)';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = ch.stroke;
      ctx.stroke();
    }
  };

  // ---- ポインタ操作 ----
  let dragPoint: ControlPoint | null = null; // ドラッグ中の点。
  let hoverPoint: ControlPoint | null = null; // 直近に掴んだ点（ハイライト用）。
  let lastTapPoint: ControlPoint | null = null;
  let lastTapTime = 0;

  /** CSS px 座標を canvas ローカルへ。 */
  const localPoint = (e: PointerEvent): { px: number; py: number } => {
    const rect = canvas.getBoundingClientRect();
    return { px: e.clientX - rect.left, py: e.clientY - rect.top };
  };

  /** ポインタ位置に最も近い点を HIT_RADIUS 以内で返す（なければ null）。 */
  const hitPoint = (px: number, py: number, points: ControlPoint[], block: number): ControlPoint | null => {
    let best: ControlPoint | null = null;
    let bestD = HIT_RADIUS * HIT_RADIUS;
    for (const p of points) {
      const dx = gx(p.x) - px;
      const dy = gy(baseAt(block, p.x) + p.dy) - py;
      const d = dx * dx + dy * dy;
      if (d <= bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  };

  /** 端点（x=0 または x=1）か。端点は削除・x 移動不可。 */
  const isEndpoint = (p: ControlPoint): boolean => p.x <= 0 || p.x >= 1;

  canvas.addEventListener('pointerdown', (e) => {
    if (disabled || !ctx || cssW <= 0) return;
    const ch = CHANNELS[selected];
    const points = edits[ch.key];
    const { px, py } = localPoint(e);

    // ① 既存点の HIT_RADIUS 以内 → 掴む（ダブルタップなら削除）。
    const hit = hitPoint(px, py, points, ch.block);
    if (hit) {
      const now = performance.now();
      if (hit === lastTapPoint && now - lastTapTime < DOUBLE_TAP_MS && !isEndpoint(hit)) {
        // ダブルタップ → 内部点を削除。
        const idx = points.indexOf(hit);
        if (idx >= 0) points.splice(idx, 1);
        lastTapPoint = null;
        dragPoint = null;
        hoverPoint = null;
        scheduleDraw();
        emitChange();
        return;
      }
      lastTapPoint = hit;
      lastTapTime = now;
      dragPoint = hit;
      hoverPoint = hit;
      canvas.setPointerCapture(e.pointerId);
      emitDrag(true);
      scheduleDraw();
      return;
    }

    // ② 曲線近傍（縦 CURVE_NEAR 以内）→ 即時に点を追加してドラッグ開始。
    const x = pxToX(px);
    const curveVal = baseAt(ch.block, x) + evalResidual(points, x);
    if (Math.abs(gy(curveVal) - py) <= CURVE_NEAR && points.length < MAX_CONTROL_POINTS) {
      const added = insertPoint(points, x, pyToVal(py) - baseAt(ch.block, x));
      if (added) {
        lastTapPoint = added;
        lastTapTime = performance.now();
        dragPoint = added;
        hoverPoint = added;
        canvas.setPointerCapture(e.pointerId);
        emitDrag(true);
        scheduleDraw();
        emitChange();
      }
      return;
    }
    // ③ どちらでもなければ何もしない。
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!dragPoint || disabled) return;
    const ch = CHANNELS[selected];
    const points = edits[ch.key];
    const { px, py } = localPoint(e);

    // dy は表示範囲を大きく超えない程度（±1）にクランプ。
    let dy = pyToVal(py) - baseAt(ch.block, dragPoint.x);
    dy = dy < -1 ? -1 : dy > 1 ? 1 : dy;
    dragPoint.dy = dy;

    // x は端点固定、内部点は隣接 ± CURVE_MIN_X_GAP にクランプ。
    if (!isEndpoint(dragPoint)) {
      const idx = points.indexOf(dragPoint);
      const loX = points[idx - 1].x + CURVE_MIN_X_GAP;
      const hiX = points[idx + 1].x - CURVE_MIN_X_GAP;
      let nx = pxToX(px);
      if (nx < loX) nx = loX;
      else if (nx > hiX) nx = hiX;
      dragPoint.x = nx;
    }

    scheduleDraw();
    emitChange();
  });

  const endDrag = (e: PointerEvent): void => {
    if (!dragPoint) return;
    dragPoint = null;
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* すでに解放済み */
    }
    emitDrag(false);
    scheduleDraw();
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  /**
   * 内部点を x へ挿入する。隣接点との CURVE_MIN_X_GAP を確保できないときは追加しない。
   * @returns 追加した点（不可なら null）
   */
  function insertPoint(points: ControlPoint[], x: number, dy: number): ControlPoint | null {
    // 挿入位置（最初に x を超える点の直前）を探す。端点は必ず両端にあるので内部に入る。
    let idx = points.length - 1;
    for (let i = 0; i < points.length; i++) {
      if (points[i].x > x) {
        idx = i;
        break;
      }
    }
    const loX = points[idx - 1].x + CURVE_MIN_X_GAP;
    const hiX = points[idx].x - CURVE_MIN_X_GAP;
    if (loX > hiX) return null; // 隙間なし。
    let nx = x;
    if (nx < loX) nx = loX;
    else if (nx > hiX) nx = hiX;
    const cdy = dy < -1 ? -1 : dy > 1 ? 1 : dy;
    const p: ControlPoint = { x: nx, dy: cdy };
    points.splice(idx, 0, p);
    return p;
  }

  // ---- タブ ----
  const syncTabs = (): void => {
    tabButtons.forEach((btn, i) => {
      const active = i === selected;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', String(active));
      btn.tabIndex = active ? 0 : -1;
    });
  };

  CHANNELS.forEach((_def, i) => {
    const btn = el('button', 'curves__tab');
    btn.type = 'button';
    btn.setAttribute('role', 'tab');
    btn.addEventListener('click', () => {
      if (disabled) return;
      selected = i;
      hoverPoint = null;
      syncTabs();
      scheduleDraw();
    });
    tabButtons.push(btn);
    append(tabRow, btn);
  });

  resetBtn.addEventListener('click', () => {
    if (disabled) return;
    doReset(false);
  });

  const doReset = (silent: boolean): void => {
    for (const key of Object.keys(edits) as Array<keyof CurveEdits>) {
      edits[key] = makeEmptyChannel();
    }
    dragPoint = null;
    hoverPoint = null;
    lastTapPoint = null;
    scheduleDraw();
    if (!silent) emitChange();
  };

  // ---- i18n ----
  const refreshText = (): void => {
    tabButtons.forEach((btn, i) => {
      const def = CHANNELS[i];
      btn.textContent = def.i18n ? t('curvesTabMaster') : def.label;
    });
    resetBtn.textContent = t('curvesReset');
    tabRow.setAttribute('aria-label', t('curvesTabsAria'));
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', t('curvesCanvasAria'));
  };
  onLangChange(refreshText);
  refreshText();
  syncTabs();

  // ---- ResizeObserver（開いた瞬間の 0→N とウィンドウリサイズで初回・再描画）----
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => scheduleDraw());
    ro.observe(canvasHost);
  }

  return {
    element: accordion.element,
    getEdits(): CurveEdits {
      const copy = (pts: ControlPoint[]): ControlPoint[] => pts.map((p) => ({ x: p.x, dy: p.dy }));
      return {
        master: copy(edits.master),
        r: copy(edits.r),
        g: copy(edits.g),
        b: copy(edits.b),
      };
    },
    setBaseCurves(effective, bins): void {
      baseCurve = effective;
      baseBins = bins;
      scheduleDraw();
    },
    setHistograms(source, result, bins): void {
      histSource = source;
      histResult = result;
      histBins = bins;
      scheduleDraw();
    },
    onChange(cb): void {
      changeCbs.push(cb);
    },
    onDragState(cb): void {
      dragCbs.push(cb);
    },
    reset(opts): void {
      doReset(opts?.silent ?? false);
    },
    setDisabled(d): void {
      disabled = d;
      accordion.element.classList.toggle('is-disabled', d);
      if (d) {
        // ドラッグ中に無効化された場合、pointerup が早期 return して drag 終了通知が
        // 漏れる（activeDrags が減らない）ため、ここで必ず終了を通知する。
        if (dragPoint) emitDrag(false);
        dragPoint = null;
        hoverPoint = null;
      }
    },
  };
}
