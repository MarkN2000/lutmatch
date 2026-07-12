/**
 * 汎用の開閉アコーディオン（§6.0 原則 3）。「自動調整」「カーブ」「詳細調整」の
 * 各グループで共有する。
 *
 * ネイティブの開閉ではなくボタン + `aria-expanded` で実装し、既定は閉。
 * 中身は呼び出し側が `body` へ append する。`setOpen` でプログラムからの
 * 開閉も可能（例：「自動調整」は Reference の投入/削除に連動して自動開閉する）。
 */

import { append, el } from './dom.ts';
import { onLangChange, t, type MessageKey } from '../i18n/index.ts';

export interface AccordionHandle {
  element: HTMLElement;
  /** 中身のコンテナ（ここに項目を追加する）。 */
  body: HTMLElement;
  /** プログラムから開閉状態を設定する（ユーザーのクリックと同じ見た目・aria 属性になる）。 */
  setOpen(open: boolean): void;
}

export function createAccordion(titleKey: MessageKey): AccordionHandle {
  const root = el('div', 'accordion');
  const btn = el('button', 'accordion__toggle');
  btn.type = 'button';
  btn.setAttribute('aria-expanded', 'false');

  const chevron = el('span', 'accordion__chevron');
  chevron.setAttribute('aria-hidden', 'true');
  chevron.textContent = '▸';
  const label = el('span', 'accordion__label');

  append(btn, chevron, label);

  const body = el('div', 'accordion__body');
  body.hidden = true;

  const setOpen = (open: boolean): void => {
    btn.setAttribute('aria-expanded', String(open));
    body.hidden = !open;
    chevron.textContent = open ? '▾' : '▸';
    root.classList.toggle('is-open', open);
  };

  btn.addEventListener('click', () => {
    setOpen(btn.getAttribute('aria-expanded') !== 'true');
  });

  const refreshText = (): void => {
    label.textContent = t(titleKey);
  };
  onLangChange(refreshText);
  refreshText();

  append(root, btn, body);
  return { element: root, body, setOpen };
}
