/**
 * カーブエディタ UI パネル（§5.7 / §5.8 / §6.1 / §6.3）。
 *
 * 「カーブ」独立アコーディオン（既定閉）の中に、チャンネルタブ
 * （マスター/R/G/B ＋ 色相/彩度）と単一の canvas を持ち、その上で編集する：
 *
 * - RGB 系（マスター/R/G/B）：縦軸＝出力値。背景に Source/結果ヒストグラム・恒等対角線・
 *   基底カーブ F（実効カーブ）。編集後カーブ F(x)+残差とコントロールポイントを描く（§5.7）。
 * - 色相系（色相＝Hue vs Hue／彩度＝Hue vs Sat）：横軸＝色相 h∈[0,1) の周期軸、縦軸＝
 *   残差 dy∈[−1,+1]（中央＝恒等）。実効カーブ F の概念はない。背景に色相グラデーション帯と
 *   色相ヒストグラム（H ブロック）、中央水平点線（恒等）、編集カーブ（周期スプライン）を描く（§5.8）。
 *
 * 編集は core/curve.ts の純粋関数で保持・評価する（RGB は非周期・色相は周期版）。
 * canvas 描画は rAF で間引き、devicePixelRatio に追従する（gl/preview-math.ts を再利用）。
 */

import { append, el, isCoarsePointer } from './dom.ts';
import { createAccordion } from './accordion.ts';
import { onLangChange, t, type MessageKey } from '../i18n/index.ts';
import {
  clampDevicePixelRatio,
  backingStoreSize,
  MAX_DEVICE_PIXEL_RATIO,
} from '../gl/preview-math.ts';
import {
  evalResidual,
  sampleResidualToGrid,
  evalResidualPeriodic,
  sampleResidualToGridPeriodic,
  MAX_CONTROL_POINTS,
  CURVE_MIN_X_GAP,
  type ControlPoint,
  type CurveEdits,
} from '../core/curve.ts';
import { lchToLab, labToLinearRgb, linearToSrgb } from '../core/colorspace.ts';

/** カーブパネルの公開ハンドル。 */
export interface CurvesHandle {
  /** アコーディオン込みのルート要素。 */
  element: HTMLElement;
  /** 現在の編集（防御的コピーを返す）。 */
  getEdits(): CurveEdits;
  /** Worker 結果の実効カーブ F [R|G|B|M]（4×bins）を差し込む。 */
  setBaseCurves(effective: Float32Array, bins: number): void;
  /** Source / 結果ヒストグラム [R|G|B|Y'|H]（各 5×bins）を差し込む。 */
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

/** カーブエディタのチャンネルキー（RGB 系＋周期の色相/彩度）。 */
type CurveKey = 'master' | 'r' | 'g' | 'b' | 'hue' | 'hueSat';

/** タブ定義。block は [R|G|B|M]／[R|G|B|Y'|H] 連結配列のブロック番号。 */
interface ChannelDef {
  key: CurveKey;
  /** タブ文言（i18nKey 未指定なら label をそのまま表示）。 */
  label: string;
  /** i18n キー（指定時は t(i18nKey) を使う）。 */
  i18nKey?: MessageKey;
  /** ヒストグラム／実効カーブ配列のブロック番号（R=0/G=1/B=2/master=3/H=4）。 */
  block: number;
  /** 周期軸（色相）タブか。true のとき縦軸 dy∈[−1,+1]・実効カーブ F なし。 */
  periodic: boolean;
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
    i18nKey: 'curvesTabMaster',
    block: 3,
    periodic: false,
    stroke: '#d7dade',
    fill: 'rgba(180, 185, 193, 0.16)',
    outline: 'rgba(200, 205, 213, 0.5)',
  },
  {
    key: 'r',
    label: 'R',
    block: 0,
    periodic: false,
    stroke: '#ef8b8b',
    fill: 'rgba(224, 96, 96, 0.16)',
    outline: 'rgba(236, 130, 130, 0.5)',
  },
  {
    key: 'g',
    label: 'G',
    block: 1,
    periodic: false,
    stroke: '#8bd39a',
    fill: 'rgba(96, 200, 120, 0.16)',
    outline: 'rgba(130, 214, 150, 0.5)',
  },
  {
    key: 'b',
    label: 'B',
    block: 2,
    periodic: false,
    stroke: '#8bb4ef',
    fill: 'rgba(96, 140, 224, 0.18)',
    outline: 'rgba(130, 170, 236, 0.5)',
  },
  {
    key: 'hue',
    label: 'Hue',
    i18nKey: 'curvesTabHue',
    block: 4,
    periodic: true,
    stroke: '#e7e2d6',
    fill: 'rgba(210, 205, 190, 0.14)',
    outline: 'rgba(216, 210, 196, 0.5)',
  },
  {
    key: 'hueSat',
    label: 'Sat',
    i18nKey: 'curvesTabHueSat',
    block: 4,
    periodic: true,
    stroke: '#d2e2da',
    fill: 'rgba(184, 208, 197, 0.14)',
    outline: 'rgba(194, 214, 203, 0.5)',
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
/** 色相タブ底部の色相グラデーション帯の高さ（CSS px）。 */
const HUE_BAND_H = 14;
/** 色相グラデーション帯の描画に使う固定 L*・C*（視認性優先の中庸値）。 */
const HUE_BAND_L = 65;
const HUE_BAND_C = 50;

/** RGB チャンネル 1 本を「編集なし」の初期状態（端点のみ・dy=0）で作る。 */
function makeEmptyChannel(): ControlPoint[] {
  return [
    { x: 0, dy: 0 },
    { x: 1, dy: 0 },
  ];
}

/**
 * 全チャンネルを初期状態にした CurveEdits を作る。
 * RGB は端点 2 点常設、色相/彩度は点 0 個（＝恒等・空編集）。
 */
function makeEmptyEdits(): CurveEdits {
  return {
    master: makeEmptyChannel(),
    r: makeEmptyChannel(),
    g: makeEmptyChannel(),
    b: makeEmptyChannel(),
    hue: [],
    hueSat: [],
  };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** dy を表示範囲 [−1,+1] にクランプ。 */
function clampDy(v: number): number {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

/** x を周期軸 [0,1) へラップ。 */
function wrap01(x: number): number {
  return ((x % 1) + 1) % 1;
}

/** 円環（周期軸）上の 2 点間距離 min(|dx|, 1−|dx|)。 */
function circDist(a: number, b: number): number {
  const d = Math.abs(wrap01(a) - wrap01(b));
  return Math.min(d, 1 - d);
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
    updateResetButtonsState(); // 点追加・ドラッグ・削除ごとに disabled 状態を同期する。
    for (const cb of changeCbs) cb();
  };
  const emitDrag = (d: boolean): void => {
    for (const cb of dragCbs) cb(d);
  };

  /** キーの編集配列を返す（未初期化なら空配列を作って保持）。 */
  const pointsOf = (key: CurveKey): ControlPoint[] => {
    let p = edits[key];
    if (!p) {
      p = [];
      edits[key] = p;
    }
    return p;
  };

  // ---- DOM 構築 ----
  const accordion = createAccordion('curvesTitle');

  const tabRow = el('div', 'curves__tabs');
  tabRow.setAttribute('role', 'tablist');
  const tabButtons: HTMLButtonElement[] = [];

  // 主＝現在選択中チャンネルのみのリセット（動的ラベル）。従＝全チャンネル一括リセット。
  const channelResetBtn = el('button', 'btn btn--ghost curves__reset-channel');
  channelResetBtn.type = 'button';
  const resetBtn = el('button', 'btn btn--ghost curves__reset');
  resetBtn.type = 'button';

  const actionsRow = el('div', 'curves__actions');
  append(actionsRow, channelResetBtn, resetBtn);

  const head = el('div', 'curves__head');
  append(head, tabRow, actionsRow);

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

  // 周期（色相）タブ用の縦軸マッピング。底部 HUE_BAND_H を色相帯へ譲り、
  // 残差 dy∈[−1,+1] はその上の領域へマップする（中央＝dy 0＝恒等）。
  const pxToXRaw = (px: number): number => (px - PAD) / plotW();
  const hueRegBot = (): number => PAD + plotH() - HUE_BAND_H; // 帯の上端＝dy 領域の下端。
  const hueRegH = (): number => Math.max(1, plotH() - HUE_BAND_H);
  const dyToPy = (dy: number): number => PAD + (1 - (clampDy(dy) + 1) / 2) * hueRegH();
  const pyToDy = (py: number): number => (1 - (py - PAD) / hueRegH()) * 2 - 1;

  // ---- 基底カーブ F の評価（RGB 系のみ）----
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

  /** 枠＋1/4 グリッド（両タブ共通）。 */
  const drawFrameGrid = (c: CanvasRenderingContext2D): void => {
    c.lineWidth = 1;
    c.strokeStyle = 'rgba(255, 255, 255, 0.06)';
    c.beginPath();
    for (let k = 1; k <= 3; k++) {
      const gxk = gx(k / 4);
      c.moveTo(gxk, gy(1));
      c.lineTo(gxk, gy(0));
      const gyk = gy(k / 4);
      c.moveTo(gx(0), gyk);
      c.lineTo(gx(1), gyk);
    }
    c.stroke();
    c.strokeStyle = 'rgba(255, 255, 255, 0.14)';
    c.strokeRect(gx(0), gy(1), plotW(), plotH());
  };

  /** RGB 系タブの描画（§5.7）。既存挙動を不変で維持。 */
  const drawRgb = (c: CanvasRenderingContext2D, ch: ChannelDef): void => {
    // Source ヒストグラム（半透明塗り）。
    if (histSource && histBins > 0) {
      c.fillStyle = ch.fill;
      const off = ch.block * histBins;
      const base = gy(0);
      const w = plotW() / histBins;
      c.beginPath();
      for (let i = 0; i < histBins; i++) {
        const d = histSource[off + i];
        if (d <= 0) continue;
        const x0 = gx(i / histBins);
        c.rect(x0, gy(d), Math.max(1, w), base - gy(d));
      }
      c.fill();
    }

    // 結果ヒストグラム（細い輪郭線）。
    if (histResult && histBins > 0) {
      c.strokeStyle = ch.outline;
      c.lineWidth = 1;
      const off = ch.block * histBins;
      c.beginPath();
      let started = false;
      for (let i = 0; i < histBins; i++) {
        const px = gx((i + 0.5) / histBins);
        const py = gy(histResult[off + i]);
        if (!started) {
          c.moveTo(px, py);
          started = true;
        } else {
          c.lineTo(px, py);
        }
      }
      c.stroke();
    }

    // 恒等対角線（薄い点線）。
    c.save();
    c.setLineDash([3, 4]);
    c.strokeStyle = 'rgba(255, 255, 255, 0.18)';
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(gx(0), gy(0));
    c.lineTo(gx(1), gy(1));
    c.stroke();
    c.restore();

    // サンプル本数（描画・残差評価を CSS 幅の 1/2 解像度で行う）。
    const nSamples = Math.max(2, Math.round(plotW() / 2));

    // 基底カーブ F（減光実線。疎データ域はさらに減光）。
    c.lineWidth = 1.5;
    for (let i = 0; i < nSamples - 1; i++) {
      const x0 = i / (nSamples - 1);
      const x1 = (i + 1) / (nSamples - 1);
      const xm = (x0 + x1) / 2;
      const sparse = sourceDensityAt(ch.block, xm) < SPARSE_THRESHOLD;
      c.globalAlpha = sparse ? 0.16 : 0.42;
      c.strokeStyle = ch.stroke;
      c.beginPath();
      c.moveTo(gx(x0), gy(baseAt(ch.block, x0)));
      c.lineTo(gx(x1), gy(baseAt(ch.block, x1)));
      c.stroke();
    }
    c.globalAlpha = 1;

    // 編集後カーブ F(x) + 残差（チャンネル色の明色実線・表示は [0,1] クリップ）。
    const points = pointsOf(ch.key);
    const residual = sampleResidualToGrid(points, nSamples);
    c.strokeStyle = ch.stroke;
    c.lineWidth = 2;
    c.beginPath();
    for (let i = 0; i < nSamples; i++) {
      const x = i / (nSamples - 1);
      const py = gy(baseAt(ch.block, x) + residual[i]); // gy が [0,1] にクランプ。
      if (i === 0) c.moveTo(gx(x), py);
      else c.lineTo(gx(x), py);
    }
    c.stroke();

    // コントロールポイント。
    const r = isCoarsePointer() ? 8 : 6;
    for (const p of points) {
      const px = gx(p.x);
      const py = gy(baseAt(ch.block, p.x) + p.dy);
      const active = p === dragPoint || p === hoverPoint;
      c.beginPath();
      c.arc(px, py, active ? r + 2 : r, 0, Math.PI * 2);
      c.fillStyle = active ? ch.stroke : 'rgba(20, 22, 26, 0.9)';
      c.fill();
      c.lineWidth = 2;
      c.strokeStyle = ch.stroke;
      c.stroke();
    }
  };

  // 色相帯の色計算用スクラッチ（毎フレームの確保を避ける）。
  const labScratch: number[] = [0, 0, 0];
  const rgbScratch: number[] = [0, 0, 0];

  /** 色相系タブ（周期軸）の描画（§5.8）。 */
  const drawHue = (c: CanvasRenderingContext2D, ch: ChannelDef): void => {
    const bandTop = hueRegBot();
    const regH = hueRegH();
    const w = plotW();

    // A) 色相グラデーション帯（底部・LCh 固定 L*・C* を h=x で回して sRGB へ）。
    const step = 2;
    for (let sx = 0; sx < w; sx += step) {
      const x = sx / w;
      lchToLab(HUE_BAND_L, HUE_BAND_C, x, labScratch);
      labToLinearRgb(labScratch[0], labScratch[1], labScratch[2], rgbScratch);
      const rr = Math.round(clamp01(linearToSrgb(rgbScratch[0])) * 255);
      const gg = Math.round(clamp01(linearToSrgb(rgbScratch[1])) * 255);
      const bb = Math.round(clamp01(linearToSrgb(rgbScratch[2])) * 255);
      c.fillStyle = `rgb(${rr}, ${gg}, ${bb})`;
      c.fillRect(gx(0) + sx, bandTop, step + 1, HUE_BAND_H);
    }

    // B) 色相ヒストグラム（H ブロック＝index 4）：Source 塗り＋結果輪郭（帯の上の領域）。
    if (histSource && histBins > 0) {
      c.fillStyle = ch.fill;
      const off = ch.block * histBins;
      const barW = plotW() / histBins;
      c.beginPath();
      for (let i = 0; i < histBins; i++) {
        const d = histSource[off + i];
        if (d <= 0) continue;
        const x0 = gx(i / histBins);
        const top = bandTop - d * regH;
        c.rect(x0, top, Math.max(1, barW), bandTop - top);
      }
      c.fill();
    }
    if (histResult && histBins > 0) {
      c.strokeStyle = ch.outline;
      c.lineWidth = 1;
      const off = ch.block * histBins;
      c.beginPath();
      let started = false;
      for (let i = 0; i < histBins; i++) {
        const px = gx((i + 0.5) / histBins);
        const py = bandTop - histResult[off + i] * regH;
        if (!started) {
          c.moveTo(px, py);
          started = true;
        } else {
          c.lineTo(px, py);
        }
      }
      c.stroke();
    }

    // C) 恒等（中央水平点線・dy=0）。
    c.save();
    c.setLineDash([3, 4]);
    c.strokeStyle = 'rgba(255, 255, 255, 0.18)';
    c.lineWidth = 1;
    const cy = dyToPy(0);
    c.beginPath();
    c.moveTo(gx(0), cy);
    c.lineTo(gx(1), cy);
    c.stroke();
    c.restore();

    // D) 編集カーブ（周期スプライン・全幅を評価。x=1 は x=0 と同一点）。
    const points = pointsOf(ch.key);
    const nSamples = Math.max(2, Math.round(w / 2));
    const residual = sampleResidualToGridPeriodic(points, nSamples);
    c.strokeStyle = ch.stroke;
    c.lineWidth = 2;
    c.beginPath();
    for (let i = 0; i <= nSamples; i++) {
      const x = i / nSamples;
      const py = dyToPy(residual[i % nSamples]);
      if (i === 0) c.moveTo(gx(x), py);
      else c.lineTo(gx(x), py);
    }
    c.stroke();

    // E) コントロールポイント。
    const r = isCoarsePointer() ? 8 : 6;
    for (const p of points) {
      const px = gx(wrap01(p.x));
      const py = dyToPy(p.dy);
      const active = p === dragPoint || p === hoverPoint;
      c.beginPath();
      c.arc(px, py, active ? r + 2 : r, 0, Math.PI * 2);
      c.fillStyle = active ? ch.stroke : 'rgba(20, 22, 26, 0.9)';
      c.fill();
      c.lineWidth = 2;
      c.strokeStyle = ch.stroke;
      c.stroke();
    }
  };

  const draw = (): void => {
    syncBacking();
    if (!ctx || cssW <= 0) return;
    const ch = CHANNELS[selected];
    ctx.clearRect(0, 0, cssW, cssH);
    drawFrameGrid(ctx);
    if (ch.periodic) drawHue(ctx, ch);
    else drawRgb(ctx, ch);
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

  /** RGB 系：ポインタ位置に最も近い点を HIT_RADIUS 以内で返す（なければ null）。 */
  const hitPointRgb = (
    px: number,
    py: number,
    points: ControlPoint[],
    block: number,
  ): ControlPoint | null => {
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

  /** 色相系：ポインタ位置に最も近い点を HIT_RADIUS 以内で返す（描画位置で判定）。 */
  const hitPointHue = (px: number, py: number, points: ControlPoint[]): ControlPoint | null => {
    let best: ControlPoint | null = null;
    let bestD = HIT_RADIUS * HIT_RADIUS;
    for (const p of points) {
      const dx = gx(wrap01(p.x)) - px;
      const dy = dyToPy(p.dy) - py;
      const d = dx * dx + dy * dy;
      if (d <= bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  };

  /** RGB 系の端点（x=0 または x=1）か。端点は削除・x 移動不可。 */
  const isEndpoint = (p: ControlPoint): boolean => p.x <= 0 || p.x >= 1;

  /** RGB 系タブの pointerdown（既存挙動を不変で維持）。 */
  const onDownRgb = (e: PointerEvent, ch: ChannelDef): void => {
    const points = pointsOf(ch.key);
    const { px, py } = localPoint(e);

    // ① 既存点の HIT_RADIUS 以内 → 掴む（ダブルタップなら内部点を削除）。
    const hit = hitPointRgb(px, py, points, ch.block);
    if (hit) {
      const now = performance.now();
      if (hit === lastTapPoint && now - lastTapTime < DOUBLE_TAP_MS && !isEndpoint(hit)) {
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
      const added = insertPointRgb(points, x, pyToVal(py) - baseAt(ch.block, x));
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
  };

  /** 色相系タブの pointerdown（周期軸・端点なし）。 */
  const onDownHue = (e: PointerEvent, ch: ChannelDef): void => {
    const points = pointsOf(ch.key);
    const { px, py } = localPoint(e);

    // ① 既存点 → 掴む（ダブルタップで削除。全点が削除対象）。
    const hit = hitPointHue(px, py, points);
    if (hit) {
      const now = performance.now();
      if (hit === lastTapPoint && now - lastTapTime < DOUBLE_TAP_MS) {
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
    const x = wrap01(pxToXRaw(px));
    const curveDy = evalResidualPeriodic(points, x);
    if (Math.abs(dyToPy(curveDy) - py) <= CURVE_NEAR && points.length < MAX_CONTROL_POINTS) {
      const added = insertPointHue(points, x, pyToDy(py));
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
  };

  canvas.addEventListener('pointerdown', (e) => {
    if (disabled || !ctx || cssW <= 0) return;
    const ch = CHANNELS[selected];
    if (ch.periodic) onDownHue(e, ch);
    else onDownRgb(e, ch);
  });

  /** RGB 系タブの pointermove（既存挙動を不変で維持）。 */
  const onMoveRgb = (e: PointerEvent, ch: ChannelDef): void => {
    const points = pointsOf(ch.key);
    const { px, py } = localPoint(e);

    // dy は表示範囲を大きく超えない程度（±1）にクランプ。
    let dy = pyToVal(py) - baseAt(ch.block, dragPoint!.x);
    dy = clampDy(dy);
    dragPoint!.dy = dy;

    // x は端点固定、内部点は隣接 ± CURVE_MIN_X_GAP にクランプ。
    if (!isEndpoint(dragPoint!)) {
      const idx = points.indexOf(dragPoint!);
      const loX = points[idx - 1].x + CURVE_MIN_X_GAP;
      const hiX = points[idx + 1].x - CURVE_MIN_X_GAP;
      let nx = pxToX(px);
      if (nx < loX) nx = loX;
      else if (nx > hiX) nx = hiX;
      dragPoint!.x = nx;
    }

    scheduleDraw();
    emitChange();
  };

  /** 色相系タブの pointermove（周期軸・ラップドラッグ）。 */
  const onMoveHue = (e: PointerEvent, ch: ChannelDef): void => {
    const points = pointsOf(ch.key);
    const { px, py } = localPoint(e);

    dragPoint!.dy = clampDy(pyToDy(py));

    // x は円環上をラップして移動。ただし他点と CURVE_MIN_X_GAP（円環距離）未満に
    // 近づく位置は採用せず（＝点の交差・併合を防ぐ）、dy のみ更新する。
    const nx = wrap01(pxToXRaw(px));
    let ok = true;
    for (const p of points) {
      if (p !== dragPoint && circDist(p.x, nx) < CURVE_MIN_X_GAP) {
        ok = false;
        break;
      }
    }
    if (ok) dragPoint!.x = nx;

    scheduleDraw();
    emitChange();
  };

  canvas.addEventListener('pointermove', (e) => {
    if (!dragPoint || disabled) return;
    const ch = CHANNELS[selected];
    if (ch.periodic) onMoveHue(e, ch);
    else onMoveRgb(e, ch);
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
   * RGB 系：内部点を x へ挿入する。隣接点との CURVE_MIN_X_GAP を確保できないときは追加しない。
   * @returns 追加した点（不可なら null）
   */
  function insertPointRgb(points: ControlPoint[], x: number, dy: number): ControlPoint | null {
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
    const p: ControlPoint = { x: nx, dy: clampDy(dy) };
    points.splice(idx, 0, p);
    return p;
  }

  /**
   * 色相系：周期軸に点を追加する。既存点と円環距離 CURVE_MIN_X_GAP 未満なら追加しない。
   * 配列順は問わない（評価側 sampleResidualToGridPeriodic が内部でソートするため）。
   * @returns 追加した点（不可なら null）
   */
  function insertPointHue(points: ControlPoint[], x: number, dy: number): ControlPoint | null {
    if (points.length >= MAX_CONTROL_POINTS) return null;
    const nx = wrap01(x);
    for (const p of points) {
      if (circDist(p.x, nx) < CURVE_MIN_X_GAP) return null;
    }
    const p: ControlPoint = { x: nx, dy: clampDy(dy) };
    points.push(p);
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

  /** チャンネルが未編集（＝リセットしても変化しない）か。RGB 系は端点2点かつ全dy=0、
   *  色相系は点0個または全dy=0 のとき未編集とみなす。 */
  const isChannelEdited = (key: CurveKey): boolean => {
    const pts = edits[key] ?? [];
    if (key === 'hue' || key === 'hueSat') {
      return pts.length > 0 && pts.some((p) => p.dy !== 0);
    }
    return pts.length !== 2 || pts.some((p) => p.dy !== 0);
  };

  /** 現在タブのリセットボタン・全体リセットボタンの disabled を編集状態から同期する。 */
  const updateResetButtonsState = (): void => {
    const curKey = CHANNELS[selected].key;
    channelResetBtn.disabled = disabled || !isChannelEdited(curKey);
    resetBtn.disabled = disabled || !CHANNELS.some((c) => isChannelEdited(c.key));
  };

  /** 現在タブのチャンネル名を差し込んだ「◯◯をリセット」ラベルへ更新する。 */
  const updateChannelResetLabel = (): void => {
    const def = CHANNELS[selected];
    const name = def.i18nKey ? t(def.i18nKey) : def.label;
    channelResetBtn.textContent = t('curvesResetChannelTemplate').replace('{name}', name);
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
      updateChannelResetLabel();
      updateResetButtonsState();
      scheduleDraw();
    });
    tabButtons.push(btn);
    append(tabRow, btn);
  });

  /** 現在タブのチャンネルのみを初期状態へ戻す（主リセット）。onChange は常に発火する。 */
  const resetChannel = (key: CurveKey): void => {
    edits[key] = key === 'hue' || key === 'hueSat' ? [] : makeEmptyChannel();
    dragPoint = null;
    hoverPoint = null;
    lastTapPoint = null;
    scheduleDraw();
    emitChange();
  };

  channelResetBtn.addEventListener('click', () => {
    if (disabled || channelResetBtn.disabled) return;
    resetChannel(CHANNELS[selected].key);
  });

  resetBtn.addEventListener('click', () => {
    if (disabled || resetBtn.disabled) return;
    doReset(false);
  });

  const doReset = (silent: boolean): void => {
    edits.master = makeEmptyChannel();
    edits.r = makeEmptyChannel();
    edits.g = makeEmptyChannel();
    edits.b = makeEmptyChannel();
    edits.hue = [];
    edits.hueSat = [];
    dragPoint = null;
    hoverPoint = null;
    lastTapPoint = null;
    scheduleDraw();
    updateResetButtonsState(); // silent（main.ts の全体リセット経由）でも disabled 表示は同期させる。
    if (!silent) emitChange();
  };

  // ---- i18n ----
  const refreshText = (): void => {
    tabButtons.forEach((btn, i) => {
      const def = CHANNELS[i];
      btn.textContent = def.i18nKey ? t(def.i18nKey) : def.label;
    });
    resetBtn.textContent = t('curvesReset');
    updateChannelResetLabel();
    tabRow.setAttribute('aria-label', t('curvesTabsAria'));
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', t('curvesCanvasAria'));
  };
  onLangChange(refreshText);
  refreshText();
  syncTabs();
  updateResetButtonsState();

  // ---- ResizeObserver（開いた瞬間の 0→N とウィンドウリサイズで初回・再描画）----
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => scheduleDraw());
    ro.observe(canvasHost);
  }

  return {
    element: accordion.element,
    getEdits(): CurveEdits {
      const copy = (pts: readonly ControlPoint[]): ControlPoint[] =>
        pts.map((p) => ({ x: p.x, dy: p.dy }));
      return {
        master: copy(edits.master),
        r: copy(edits.r),
        g: copy(edits.g),
        b: copy(edits.b),
        hue: copy(edits.hue ?? []),
        hueSat: copy(edits.hueSat ?? []),
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
      updateResetButtonsState();
    },
  };
}
