/**
 * 共通スライダー（§4.4 / §6.3）。
 *
 * - ネイティブ `input[type=range]` ベースでキーボード操作・ARIA を確保
 * - 数値ラベルタップで直接数値入力
 * - ダブルクリック / ダブルタップで既定値へリセット
 * - 連続変化は `onInput`、ドラッグ状態は `onDragState` で通知（段階的描画用）
 * - タッチターゲット 44px 以上は CSS 側で確保
 */

import { append, clear, el } from './dom.ts';
import { onLangChange, t, type MessageKey } from '../i18n/index.ts';

/** スライダー設定。 */
export interface SliderConfig {
  labelKey: MessageKey;
  tooltipKey: MessageKey;
  min: number;
  max: number;
  step: number;
  value: number;
  /** 既定値（ダブルクリック / リセット時に戻す値）。 */
  defaultValue: number;
  /** 表示用フォーマッタ（単位付き）。 */
  format: (value: number) => string;
  /** 連続変化通知。 */
  onInput: (value: number) => void;
  /** ドラッグ状態通知（段階的レンダリング用）。 */
  onDragState?: (dragging: boolean) => void;
}

/** スライダーの公開ハンドル。 */
export interface SliderHandle {
  element: HTMLElement;
  getValue(): number;
  /** 値を設定（silent=true で onInput を発火しない）。 */
  setValue(value: number, silent?: boolean): void;
  setDisabled(disabled: boolean): void;
}

export function createSlider(config: SliderConfig): SliderHandle {
  const root = el('div', 'slider');

  const head = el('div', 'slider__head');
  const label = el('label', 'slider__label');
  const valueBtn = el('button', 'slider__value');
  valueBtn.type = 'button';
  append(head, label, valueBtn);

  const range = el('input', 'slider__range');
  range.type = 'range';
  range.min = String(config.min);
  range.max = String(config.max);
  range.step = String(config.step);
  range.value = String(config.value);

  append(root, head, range);

  let value = config.value;

  const applyAria = (): void => {
    const text = `${t(config.labelKey)}: ${config.format(value)}`;
    range.setAttribute('aria-label', text);
    range.title = t(config.tooltipKey);
    valueBtn.setAttribute('aria-label', `${t(config.labelKey)} を直接入力`);
  };

  const refreshText = (): void => {
    label.textContent = t(config.labelKey);
    label.title = t(config.tooltipKey);
    valueBtn.textContent = config.format(value);
    applyAria();
  };

  const commitValue = (next: number, silent = false): void => {
    const clamped = Math.min(config.max, Math.max(config.min, next));
    value = clamped;
    range.value = String(clamped);
    valueBtn.textContent = config.format(clamped);
    applyAria();
    if (!silent) config.onInput(clamped);
  };

  range.addEventListener('input', () => {
    commitValue(Number(range.value));
  });

  // ドラッグ状態（段階的描画のヒント）。
  const startDrag = (): void => config.onDragState?.(true);
  const endDrag = (): void => config.onDragState?.(false);
  range.addEventListener('pointerdown', startDrag);
  range.addEventListener('pointerup', endDrag);
  range.addEventListener('pointercancel', endDrag);
  range.addEventListener('keydown', startDrag);
  range.addEventListener('keyup', endDrag);

  // ダブルクリック / ダブルタップで既定値へ。
  root.addEventListener('dblclick', () => commitValue(config.defaultValue));

  // 数値ラベルタップ → 直接入力。
  valueBtn.addEventListener('click', () => {
    const input = el('input', 'slider__number');
    input.type = 'number';
    input.min = String(config.min);
    input.max = String(config.max);
    input.step = String(config.step);
    input.value = String(value);
    clear(head);
    append(head, label, input);
    input.focus();
    input.select();

    let finished = false;
    const finish = (accept: boolean, restoreFocus: boolean): void => {
      if (finished) return;
      finished = true;
      if (accept && input.value !== '') commitValue(Number(input.value));
      clear(head);
      append(head, label, valueBtn);
      refreshText();
      // Enter/Escape による確定時のみフォーカスを値ボタンへ戻す。
      // blur（別要素クリック等）ではユーザーの操作先を優先し、フォーカスを奪わない。
      if (restoreFocus) valueBtn.focus();
    };
    input.addEventListener('blur', () => finish(true, false));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true, true);
      else if (e.key === 'Escape') finish(false, true);
    });
  });

  // コンポーネントはアプリのライフサイクル全体で生存するため解除は不要。
  onLangChange(refreshText);

  refreshText();

  return {
    element: root,
    getValue: () => value,
    setValue: (v, silent) => commitValue(v, silent),
    setDisabled: (disabled) => {
      range.disabled = disabled;
      valueBtn.disabled = disabled;
      root.classList.toggle('is-disabled', disabled);
    },
  };
}
