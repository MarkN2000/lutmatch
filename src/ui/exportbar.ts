/**
 * 書き出しバー（§4.6 / §6.3）。
 *
 * - DL プライマリボタン 1 つ（既定値ならワンタップで保存）
 * - サイズ選択 17 / 33 / 65（既定 33）→ 変更時は LUT 再生成が必要
 * - ファイル名（既定 `lutmatch_YYYYMMDD_HHmm.cube`）
 * - 「適用後を PNG 保存」ボタン
 * - モバイルではファイル名/サイズを展開トグルに格納
 */

import { append, el } from './dom.ts';
import { onLangChange, t } from '../i18n/index.ts';

export const LUT_SIZES = [17, 33, 65] as const;
export const DEFAULT_LUT_SIZE = 33;

export interface ExportBarConfig {
  onSizeChange: (size: number) => void;
  onDownload: () => void;
  onSavePng: () => void;
  onSaveResonite: () => void;
}

/** setBusy の対象ボタン（既定は DL）。 */
export type ExportBusyTarget = 'download' | 'resonite';

export interface ExportBarHandle {
  element: HTMLElement;
  getSize(): number;
  getFileName(): string;
  setDisabled(disabled: boolean): void;
  setBusy(busy: boolean, target?: ExportBusyTarget): void;
}

/** 既定ファイル名 `lutmatch_YYYYMMDD_HHmm.cube` を現在時刻から作る。 */
export function defaultFileName(now: Date = new Date()): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  const stamp =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `_${p(now.getHours())}${p(now.getMinutes())}`;
  return `lutmatch_${stamp}.cube`;
}

/** ファイル名に `.cube` 拡張子を保証する。 */
function ensureCubeExt(name: string): string {
  const trimmed = name.trim();
  if (trimmed === '') return defaultFileName();
  return trimmed.toLowerCase().endsWith('.cube') ? trimmed : `${trimmed}.cube`;
}

export function createExportBar(config: ExportBarConfig): ExportBarHandle {
  const root = el('div', 'exportbar');

  // ---- 展開トグル（モバイル）----
  const optToggle = el('button', 'exportbar__opt-toggle');
  optToggle.type = 'button';
  optToggle.setAttribute('aria-expanded', 'false');
  optToggle.textContent = '⚙';

  const options = el('div', 'exportbar__options');

  // サイズ選択。
  const sizeGroup = el('div', 'exportbar__sizes');
  sizeGroup.setAttribute('role', 'radiogroup');
  const sizeLabel = el('span', 'exportbar__label');
  append(sizeGroup, sizeLabel);
  let size = DEFAULT_LUT_SIZE;
  const sizeButtons = new Map<number, HTMLButtonElement>();
  const syncSizes = (): void => {
    for (const [s, btn] of sizeButtons) {
      const active = s === size;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-checked', String(active));
    }
  };
  for (const s of LUT_SIZES) {
    const btn = el('button', 'exportbar__size');
    btn.type = 'button';
    btn.setAttribute('role', 'radio');
    btn.textContent = String(s);
    btn.addEventListener('click', () => {
      if (size === s) return;
      size = s;
      syncSizes();
      config.onSizeChange(s);
    });
    sizeButtons.set(s, btn);
    append(sizeGroup, btn);
  }

  // ファイル名。
  const nameRow = el('label', 'exportbar__name');
  const nameLabel = el('span', 'exportbar__label');
  const nameInput = el('input', 'exportbar__name-input');
  nameInput.type = 'text';
  nameInput.value = defaultFileName();
  nameInput.spellcheck = false;
  append(nameRow, nameLabel, nameInput);

  append(options, sizeGroup, nameRow);

  // ---- アクション ----
  const actions = el('div', 'exportbar__actions');
  const pngBtn = el('button', 'btn btn--ghost exportbar__png');
  pngBtn.type = 'button';
  pngBtn.addEventListener('click', () => config.onSavePng());

  const resoniteBtn = el('button', 'btn btn--ghost exportbar__resonite');
  resoniteBtn.type = 'button';
  resoniteBtn.addEventListener('click', () => config.onSaveResonite());

  const dlBtn = el('button', 'btn btn--primary exportbar__dl');
  dlBtn.type = 'button';
  dlBtn.addEventListener('click', () => config.onDownload());
  append(actions, pngBtn, resoniteBtn, dlBtn);

  optToggle.addEventListener('click', () => {
    const open = optToggle.getAttribute('aria-expanded') !== 'true';
    optToggle.setAttribute('aria-expanded', String(open));
    root.classList.toggle('is-options-open', open);
  });

  append(root, optToggle, options, actions);

  const refreshText = (): void => {
    sizeLabel.textContent = t('exportSizeLabel');
    nameLabel.textContent = t('fileNameLabel');
    dlBtn.textContent = t('downloadButton');
    pngBtn.textContent = t('savePngButton');
    resoniteBtn.textContent = t('saveResoniteButton');
    optToggle.setAttribute('aria-label', t('exportDetailsAria'));
    nameInput.setAttribute('aria-label', t('fileNameLabel'));
  };
  onLangChange(refreshText);
  refreshText();
  syncSizes();

  return {
    element: root,
    getSize: () => size,
    getFileName: () => ensureCubeExt(nameInput.value),
    setDisabled: (disabled) => {
      root.classList.toggle('is-disabled', disabled);
      dlBtn.disabled = disabled;
      pngBtn.disabled = disabled;
      resoniteBtn.disabled = disabled;
      nameInput.disabled = disabled;
      for (const btn of sizeButtons.values()) btn.disabled = disabled;
    },
    setBusy: (busy, target = 'download') => {
      const btn = target === 'resonite' ? resoniteBtn : dlBtn;
      btn.classList.toggle('is-busy', busy);
      btn.disabled = busy;
    },
  };
}
