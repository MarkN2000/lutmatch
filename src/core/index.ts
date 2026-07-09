/**
 * コアアルゴリズム層の公開 API バレル。
 * Web Worker（src/worker/match.worker.ts）はここから import する。
 */

export * from './types.ts';
export {
  srgbToLinear,
  linearToSrgb,
  srgbToLinearRgb,
  linearToSrgbRgb,
  rec709Luminance,
  linearRgbToLab,
  labToLinearRgb,
} from './colorspace.ts';
export {
  N_MIN_PIXELS,
  COV_REG_FACTOR,
  extractValidSamples,
  computeColorStats,
  regularizeCov,
  regularizedCovInv,
} from './stats.ts';
export { buildMkl, applyLinearTransform, MKL_RANK_RATIO } from './mkl.ts';
export type { LinearTransform, MklResult } from './mkl.ts';
export {
  HM_BINS,
  HM_RESIDUAL_SMOOTH_SIGMA,
  buildHistMatch,
  applyCurveGamma,
  applyHistMatch,
} from './histmatch.ts';
export type { ChannelCurve, HistMatchCurves } from './histmatch.ts';
export { buildMatchTransform } from './pipeline.ts';
export type { MatchTransform } from './pipeline.ts';
export {
  generateLut,
  trilinearSample,
  MAHALANOBIS_D0,
  MAHALANOBIS_D1,
  SMOOTH_SIGMA_MAX,
  TEMPTINT_SCALE,
} from './lut.ts';
export { serializeCube, sanitizeTitle, DEFAULT_TITLE } from './cube.ts';
