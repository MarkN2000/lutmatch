/**
 * モード 3 択セグメントコントロール（§4.2 / §6.1）。
 *
 * ラジオグループ相当のセマンティクスで、モード A/B/C を排他選択する。
 * 各ボタンにツールチップ（i18n）を付与する。
 */

import { append, el } from './dom.ts';
import { onLangChange, t, type MessageKey } from '../i18n/index.ts';
import type { MatchMode } from '../core/index.ts';

interface SegmentOption {
  value: MatchMode;
  nameKey: MessageKey;
  descKey: MessageKey;
}

const OPTIONS: SegmentOption[] = [
  { value: 'C', nameKey: 'modeCName', descKey: 'modeCDesc' },
  { value: 'A', nameKey: 'modeAName', descKey: 'modeADesc' },
  { value: 'B', nameKey: 'modeBName', descKey: 'modeBDesc' },
];

export interface SegmentHandle {
  element: HTMLElement;
  getValue(): MatchMode;
  setValue(value: MatchMode, silent?: boolean): void;
  setDisabled(disabled: boolean): void;
}

export function createModeSegment(
  initial: MatchMode,
  onChange: (mode: MatchMode) => void,
): SegmentHandle {
  const root = el('div', 'segment');
  root.setAttribute('role', 'radiogroup');
  root.setAttribute('aria-label', t('modeLabel'));

  let value = initial;
  const buttons = new Map<MatchMode, HTMLButtonElement>();

  const sync = (): void => {
    for (const [mode, btn] of buttons) {
      const active = mode === value;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-checked', String(active));
      btn.tabIndex = active ? 0 : -1;
    }
  };

  for (const opt of OPTIONS) {
    const btn = el('button', 'segment__btn');
    btn.type = 'button';
    btn.setAttribute('role', 'radio');
    btn.addEventListener('click', () => {
      if (value === opt.value) return;
      value = opt.value;
      sync();
      onChange(value);
    });
    buttons.set(opt.value, btn);
    append(root, btn);
  }

  const refreshText = (): void => {
    root.setAttribute('aria-label', t('modeLabel'));
    for (const opt of OPTIONS) {
      const btn = buttons.get(opt.value);
      if (btn) {
        btn.textContent = t(opt.nameKey);
        btn.title = t(opt.descKey);
      }
    }
  };

  onLangChange(refreshText);
  refreshText();
  sync();

  return {
    element: root,
    getValue: () => value,
    setValue: (v, silent) => {
      value = v;
      sync();
      if (!silent) onChange(v);
    },
    setDisabled: (disabled) => {
      for (const btn of buttons.values()) btn.disabled = disabled;
      root.classList.toggle('is-disabled', disabled);
    },
  };
}
