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
  MKL_EPS_ABS,
  extractValidSamples,
  computeColorStats,
  regularizeCov,
  regularizedCovInv,
} from './stats.ts';
export {
  buildMkl,
  applyLinearTransform,
  MKL_MAX_GAIN,
  MKL_ANISO_FULL,
  MKL_ANISO_DIAG,
} from './mkl.ts';
export type { LinearTransform, MklResult } from './mkl.ts';
export {
  HM_BINS,
  HM_RESIDUAL_SMOOTH_SIGMA,
  noiseSuppressionSigma,
  noiseSuppressionSlopeMax,
  clampCurveSlope,
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
  smoothGrid,
  MAHALANOBIS_D0,
  MAHALANOBIS_D1,
  SMOOTH_SIGMA_MAX,
  TEMPTINT_SCALE,
} from './lut.ts';
export { serializeCube, sanitizeTitle, DEFAULT_TITLE } from './cube.ts';
export {
  MAX_CONTROL_POINTS,
  CURVE_MIN_X_GAP,
  evalResidual,
  sampleResidualToGrid,
  isEmptyEdits,
} from './curve.ts';
export type { ControlPoint, CurveEdits } from './curve.ts';
export {
  CURVE_BINS,
  HIST_BINS,
  gammaLuma,
  computeEffectiveCurves,
  computeHistogram,
  computeResultHistogram,
} from './analysis.ts';
