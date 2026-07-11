/**
 * English message dictionary (§4.7).
 *
 * Typed as `Record<MessageKey, string>` so any key missing relative to the
 * Japanese source dictionary is a compile error (see index.ts).
 */

import type { MessageKey } from './index.ts';

export const en: Record<MessageKey, string> = {
  // ---- App / header ----
  appTitle: 'LUT Match',
  appTagline: 'Auto-generate a color-matching 3D LUT from two images',
  langToggle: '日本語',
  langToggleAria: 'Switch language to Japanese',
  helpAria: 'Show help',

  // ---- Input (dropzones) ----
  sourceTitle: 'Source',
  referenceTitle: 'Reference',
  dropHint: 'Drag & drop or click to choose',
  dropReplaceHint: 'Click to replace',
  dropFormats: 'JPEG / PNG / WebP',
  sampleButton: 'Try sample images',
  guideSource: 'Choose a source image first',
  guideReference: 'Now choose a reference image',

  // ---- Auto match (modes) ----
  modeLabel: 'Auto match',
  modeAName: 'Natural',
  modeBName: 'Faithful',
  modeCName: 'Balanced',
  modeADesc: 'Linear match only. Safest when subjects differ a lot.',
  modeBDesc: 'Per-channel histogram match. Pushes tone harder.',
  modeCDesc: 'Composite pipeline (default). Nonlinear yet stable.',

  // ---- Strength / advanced ----
  strengthLabel: 'Strength',
  strengthTooltip: 'Blend between the auto match and the original color. Does not affect manual adjustments.',
  detailsTitle: 'Advanced',
  smoothingLabel: 'Smoothing',
  smoothingTooltip: 'Smooths the 3D LUT to reduce banding and color spikes.',
  noiseSuppressionLabel: 'Noise suppression',
  noiseSuppressionTooltip: 'Limits abrupt tonal changes to avoid amplifying noise (not a noise reduction filter).',
  noiseSuppressionDisabledReason: 'Has no effect in Natural mode, which does not use histogram matching.',
  exposureLabel: 'Exposure',
  exposureTooltip: 'Brightness (EV). Multiplies by 2^EV in linear space.',
  contrastLabel: 'Contrast',
  contrastTooltip: 'S-curve around mid-gray.',
  saturationLabel: 'Saturation',
  saturationTooltip: 'Increase or decrease color vividness.',
  temperatureLabel: 'Temperature',
  temperatureTooltip: 'Blue⇄yellow shift (Lab b* axis).',
  tintLabel: 'Tint',
  tintTooltip: 'Green⇄magenta shift (Lab a* axis).',
  blackLabel: 'Black protect',
  blackTooltip: 'Excludes dark pixels from the match to keep deep blacks.',
  resetButton: 'Reset adjustments',

  // ---- Preview ----
  tabOriginal: 'Original',
  tabResult: 'Result',
  tabCompare: 'Compare',
  referenceThumbAlt: 'Reference (target)',
  previewEmpty: 'Choose images to see the preview here',
  computing: 'Computing…',
  compareHandleAria: 'Compare slider (use arrow keys)',

  // ---- Export ----
  exportSizeLabel: 'Size',
  fileNameLabel: 'File name',
  downloadButton: 'Download LUT',
  savePngButton: 'Save result PNG',
  exportDetailsAria: 'File name and size options',

  // ---- Toasts / errors ----
  errUnsupported: 'This format cannot be read. Please convert to JPEG and try again.',
  errDecode: 'Failed to load the image. Please try a different file.',
  errSample: 'Failed to load the sample images.',
  errGenerate: 'Computation failed. Please try again.',
  warnFallback: 'Statistics were unstable, so a simplified (mean-shift) match was used.',
  warnCanvas2d: 'WebGL is unavailable, so Canvas 2D rendering is used.',
  toastClose: 'Close',

  // ---- Help modal ----
  helpTitle: 'How to use',
  helpStep1Title: '1. Choose a source',
  helpStep1Body: 'Load the photo whose colors you want to change (Source).',
  helpStep2Title: '2. Choose a reference',
  helpStep2Body: 'Load a photo with the look you want (Reference).',
  helpStep3Title: '3. Adjust & export',
  helpStep3Body: 'Tune mode and strength, then download the .cube.',
  helpRangeTitle: 'What a LUT can do',
  helpRangeBody:
    'A LUT only remaps colors. It cannot reproduce spatial effects such as grain, blur, or vignetting. The closer the two subjects are, the better the result.',
  helpClose: 'Close',

  firstHint:
    'This tool transfers the color mood of the reference image. The closer the two images are in subject and brightness, the more natural the result — completely different scenes will not match well.',
};
