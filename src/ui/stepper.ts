/**
 * 進行インジケーター（§6.0）。
 *
 * 「1 画像を選ぶ → 2 調整 → 3 書き出し」を表示し、現在地をハイライトする。
 * 画面分割はしない（全機能は 1 画面）。
 */

import { append, el } from './dom.ts';
import { onLangChange, t, type MessageKey } from '../i18n/index.ts';

/** 現在ステップ（1/2/3）。 */
export type StepIndex = 1 | 2 | 3;

export interface StepperHandle {
  element: HTMLElement;
  setCurrent(step: StepIndex): void;
}

const STEP_KEYS: Record<StepIndex, MessageKey> = { 1: 'step1', 2: 'step2', 3: 'step3' };

export function createStepper(): StepperHandle {
  const root = el('ol', 'stepper');
  root.setAttribute('aria-label', 'progress');

  let current: StepIndex = 1;
  const items = new Map<StepIndex, { li: HTMLElement; label: HTMLElement }>();

  for (const step of [1, 2, 3] as StepIndex[]) {
    const li = el('li', 'stepper__item');
    const num = el('span', 'stepper__num');
    num.textContent = String(step);
    const label = el('span', 'stepper__label');
    append(li, num, label);
    append(root, li);
    items.set(step, { li, label });
  }

  const sync = (): void => {
    for (const [step, { li }] of items) {
      li.classList.toggle('is-current', step === current);
      li.classList.toggle('is-done', step < current);
      li.setAttribute('aria-current', step === current ? 'step' : 'false');
    }
  };

  const refreshText = (): void => {
    for (const [step, { label }] of items) label.textContent = t(STEP_KEYS[step]);
  };
  onLangChange(refreshText);
  refreshText();
  sync();

  return {
    element: root,
    setCurrent: (step) => {
      current = step;
      sync();
    },
  };
}
