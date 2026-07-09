/**
 * 共有型定義（純粋なアルゴリズム層）。
 *
 * ベクトル・行列は `number[]` で表現する（Vec3=長さ3、Mat3=長さ9・行優先）。
 * ピクセルデータはすべてリニア RGB を前提とする（sRGB→リニア変換は呼び出し側＝Worker の責務）。
 */

/** 3 要素ベクトル（長さ 3）。 */
export type Vec3 = number[];

/** 3×3 行列（長さ 9・行優先 `m[row*3 + col]`）。 */
export type Mat3 = number[];

/** 自動マッチのモード。A=MKL / B=HM / C=HM→MKL→HM 複合（既定）。 */
export type MatchMode = 'A' | 'B' | 'C';

/** 入力ピクセル配列のチャンネル数。3=RGB、4=RGBA。 */
export type ChannelCount = 3 | 4;

/**
 * 色統計（リニア RGB 空間）。
 * @property mean 平均ベクトル μ
 * @property cov  共分散行列 Σ（正則化前・生の標本共分散）
 * @property count 有効画素（RGB 三つ組）の数
 */
export interface ColorStats {
  mean: Vec3;
  cov: Mat3;
  count: number;
}

/** 手動調整パラメーター（spec §4.4 / §5.5）。 */
export interface ManualAdjustments {
  /** 露出 −2.0〜+2.0 EV（リニア ×2^EV）。 */
  exposure: number;
  /** コントラスト −50〜+50（ガンマ空間・ピボット 0.5 の S カーブ）。 */
  contrast: number;
  /** 彩度 −100〜+100（Rec.709 リニア輝度ブレンド）。 */
  saturation: number;
  /** 色温度 −100〜+100（Lab の b* 軸オフセット）。 */
  temperature: number;
  /** ティント −100〜+100（Lab の a* 軸オフセット）。 */
  tint: number;
}

/** 手動調整の既定値（すべて無効化＝恒等）。 */
export const NEUTRAL_ADJUSTMENTS: ManualAdjustments = {
  exposure: 0,
  contrast: 0,
  saturation: 0,
  temperature: 0,
  tint: 0,
};

/** 有効画素の抽出条件。 */
export interface SampleOptions {
  /** アルファしきい値。これ未満のアルファを持つ画素を統計から除外（既定 0.5）。 */
  alphaThreshold: number;
  /**
   * ブラック保護しきい値。**リニア輝度**（Rec.709）がこれ未満の画素を除外する。
   * UI の知覚（sRGB）% は呼び出し側で sRGB→リニア変換してから渡す責務分担
   * （リニア 0.05 は知覚 ≒24.5% に相当するため、UI の % をそのまま渡してはならない）。
   */
  blackThreshold: number;
}

/** `generateLut` の入力オプション。 */
export interface GenerateLutOptions {
  /** 自動マッチのモード。 */
  mode: MatchMode;
  /** LUT の格子解像度 N（17 / 33 / 65 など）。 */
  size: number;
  /** 強度（Identity ミックス率）0–100。自動マッチ結果にのみ作用。 */
  strength: number;
  /** スムージング 0–100（3D ガウシアン平滑化）。 */
  smoothing: number;
  /** 手動調整。 */
  manual: ManualAdjustments;
  /** 有効画素抽出条件。 */
  sample: SampleOptions;
  /** マハラノビス減衰の開始距離 d0（既定 3.0）。 */
  d0?: number;
}

/** `generateLut` の出力。 */
export interface GenerateLutResult {
  /** LUT データ（長さ N³×3・R が最速で回る順序・ガンマ RGB 値）。 */
  lut: Float32Array;
  /** 格子解像度 N。 */
  size: number;
  /** フォールバック（平均シフト or ランク落ち）が発生したか。UI 警告用。 */
  fallback: boolean;
}
