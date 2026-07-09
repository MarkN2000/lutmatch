/**
 * ヘルプモーダル（§6.4）。
 *
 * 3 ステップ図解（絵文字程度）と「LUT が扱える範囲」の注記を表示する。
 * フォーカストラップは簡易（Escape とオーバーレイクリックで閉じる）。
 */

import { append, el } from './dom.ts';
import { onLangChange, t, type MessageKey } from '../i18n/index.ts';

export interface HelpModalHandle {
  element: HTMLElement;
  open(): void;
  close(): void;
}

interface StepDef {
  emoji: string;
  titleKey: MessageKey;
  bodyKey: MessageKey;
}

const STEPS: StepDef[] = [
  { emoji: '🖼️', titleKey: 'helpStep1Title', bodyKey: 'helpStep1Body' },
  { emoji: '🎯', titleKey: 'helpStep2Title', bodyKey: 'helpStep2Body' },
  { emoji: '🎚️', titleKey: 'helpStep3Title', bodyKey: 'helpStep3Body' },
];

export function createHelpModal(): HelpModalHandle {
  const overlay = el('div', 'modal-overlay');
  overlay.hidden = true;

  const dialog = el('div', 'modal');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');

  const heading = el('h2', 'modal__title');
  const closeBtn = el('button', 'modal__close');
  closeBtn.type = 'button';
  closeBtn.textContent = '×';

  const header = el('div', 'modal__header');
  append(header, heading, closeBtn);

  const steps = el('div', 'help-steps');
  const stepEls = STEPS.map((s) => {
    const item = el('div', 'help-step');
    const emoji = el('div', 'help-step__emoji');
    emoji.setAttribute('aria-hidden', 'true');
    emoji.textContent = s.emoji;
    const stitle = el('div', 'help-step__title');
    const sbody = el('div', 'help-step__body');
    append(item, emoji, stitle, sbody);
    append(steps, item);
    return { stitle, sbody };
  });

  const rangeBox = el('div', 'help-range');
  const rangeTitle = el('h3', 'help-range__title');
  const rangeBody = el('p', 'help-range__body');
  append(rangeBox, rangeTitle, rangeBody);

  const footer = el('div', 'modal__footer');
  const okBtn = el('button', 'btn btn--primary');
  okBtn.type = 'button';
  append(footer, okBtn);

  append(dialog, header, steps, rangeBox, footer);
  append(overlay, dialog);

  const refreshText = (): void => {
    heading.textContent = t('helpTitle');
    closeBtn.setAttribute('aria-label', t('helpClose'));
    okBtn.textContent = t('helpClose');
    dialog.setAttribute('aria-label', t('helpTitle'));
    STEPS.forEach((s, i) => {
      stepEls[i].stitle.textContent = t(s.titleKey);
      stepEls[i].sbody.textContent = t(s.bodyKey);
    });
    rangeTitle.textContent = t('helpRangeTitle');
    rangeBody.textContent = t('helpRangeBody');
  };

  const close = (): void => {
    overlay.hidden = true;
  };
  const open = (): void => {
    overlay.hidden = false;
    okBtn.focus();
  };

  closeBtn.addEventListener('click', close);
  okBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', (e) => {
    if (!overlay.hidden && e.key === 'Escape') close();
  });

  onLangChange(refreshText);
  refreshText();

  return { element: overlay, open, close };
}
