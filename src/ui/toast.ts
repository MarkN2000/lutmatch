/**
 * トースト通知（§6.2 / §6.4）。
 *
 * エラー（非対応形式・デコード失敗・計算失敗）や警告（フォールバック発生）を
 * 直前の状態を維持したまま通知する。文言は呼び出し時点で解決済みの文字列を渡す
 * （言語トグル後の再翻訳より、一時通知の即時性を優先）。
 */

import { append, el } from './dom.ts';
import { t } from '../i18n/index.ts';

export type ToastKind = 'error' | 'warning' | 'info';

export interface ToastHost {
  element: HTMLElement;
  show(message: string, kind?: ToastKind, durationMs?: number): void;
}

export function createToastHost(): ToastHost {
  const root = el('div', 'toast-host');
  root.setAttribute('role', 'status');
  root.setAttribute('aria-live', 'polite');

  const show = (message: string, kind: ToastKind = 'error', durationMs = 6000): void => {
    const toast = el('div', `toast toast--${kind}`);
    const text = el('span', 'toast__text');
    text.textContent = message;
    const close = el('button', 'toast__close');
    close.type = 'button';
    close.setAttribute('aria-label', t('toastClose'));
    close.textContent = '×';

    let removed = false;
    const remove = (): void => {
      if (removed) return;
      removed = true;
      toast.classList.add('is-leaving');
      setTimeout(() => toast.remove(), 200);
    };
    close.addEventListener('click', remove);
    append(toast, text, close);
    append(root, toast);
    if (durationMs > 0) setTimeout(remove, durationMs);
  };

  return { element: root, show };
}
