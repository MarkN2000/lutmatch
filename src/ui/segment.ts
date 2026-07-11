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
  /**
   * 有効/無効を切り替える。`reasonKey` を渡すと無効中のツールチップを
   * その理由文言に差し替える（例: 参考画像がないと使えない旨）。
   * 無効化解除時（disabled=false）は自動的に各モードの説明へ戻る。
   */
  setDisabled(disabled: boolean, reasonKey?: MessageKey): void;
}

export function createModeSegment(
  initial: MatchMode,
  onChange: (mode: MatchMode) => void,
): SegmentHandle {
  const root = el('div', 'segment');
  root.setAttribute('role', 'radiogroup');
  root.setAttribute('aria-label', t('modeLabel'));

  let value = initial;
  // 無効化理由（disabled 中のみ有効）。指定時は各ボタン・ルートのツールチップを理由文言に差し替える。
  let disabledReasonKey: MessageKey | null = null;
  const buttons = new Map<MatchMode, HTMLButtonElement>();

  const sync = (): void => {
    for (const [mode, btn] of buttons) {
      const active = mode === value;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-checked', String(active));
      btn.tabIndex = active ? 0 : -1;
    }
  };

  const select = (index: number): void => {
    const opt = OPTIONS[index];
    const btn = buttons.get(opt.value);
    if (!btn) return;
    if (value !== opt.value) {
      value = opt.value;
      sync();
      onChange(value);
    }
    btn.focus();
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
    btn.addEventListener('keydown', (e) => {
      const idx = OPTIONS.findIndex((o) => o.value === opt.value);
      let nextIdx: number;
      switch (e.key) {
        case 'ArrowLeft':
        case 'ArrowUp':
          nextIdx = (idx - 1 + OPTIONS.length) % OPTIONS.length;
          break;
        case 'ArrowRight':
        case 'ArrowDown':
          nextIdx = (idx + 1) % OPTIONS.length;
          break;
        case 'Home':
          nextIdx = 0;
          break;
        case 'End':
          nextIdx = OPTIONS.length - 1;
          break;
        default:
          return;
      }
      e.preventDefault();
      select(nextIdx);
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
        // 無効理由が指定されていればそれを、通常時は各モードの説明をツールチップに表示する。
        btn.title = disabledReasonKey != null ? t(disabledReasonKey) : t(opt.descKey);
      }
    }
    // 無効ボタンは hover しても title が出にくいため、ルートにも理由を持たせる。
    root.title = disabledReasonKey != null ? t(disabledReasonKey) : '';
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
    setDisabled: (disabled, reasonKey) => {
      for (const btn of buttons.values()) btn.disabled = disabled;
      root.classList.toggle('is-disabled', disabled);
      disabledReasonKey = disabled ? (reasonKey ?? null) : null;
      refreshText();
    },
  };
}
