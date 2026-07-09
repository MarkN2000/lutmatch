/**
 * i18n ランタイム（§4.7）。
 *
 * - `navigator.language` から初期言語を判定（`ja*` → ja、他 → en）
 * - 選択は `localStorage` に保存（try/catch で保護）
 * - 切替時に `<html lang>` を同期し、購読者へ通知
 * - 文言は ja.ts / en.ts の辞書で一元管理（キーは ja が正）
 */

import { ja } from './ja.ts';
import { en } from './en.ts';

/** 対応言語コード。 */
export type Lang = 'ja' | 'en';

/** 全 UI 文言のキー（ja 辞書のキー集合が正）。 */
export type MessageKey = keyof typeof ja;

const DICTS: Record<Lang, Record<MessageKey, string>> = { ja, en };
const STORAGE_KEY = 'lutmatch.lang';

/** localStorage から保存済み言語を読む（失敗時 null）。 */
function readStoredLang(): Lang | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'ja' || v === 'en' ? v : null;
  } catch {
    return null;
  }
}

/** localStorage に言語を保存（失敗は無視）。 */
function storeLang(lang: Lang): void {
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* プライベートモード等では黙って無視 */
  }
}

/** ブラウザ設定から初期言語を判定する。 */
function detectInitialLang(): Lang {
  const stored = readStoredLang();
  if (stored) return stored;
  const nav = typeof navigator !== 'undefined' ? navigator.language.toLowerCase() : 'en';
  return nav.startsWith('ja') ? 'ja' : 'en';
}

let current: Lang = detectInitialLang();
const listeners = new Set<() => void>();

/** 現在の言語。 */
export function getLang(): Lang {
  return current;
}

/** キーから現在言語の文言を引く。 */
export function t(key: MessageKey): string {
  return DICTS[current][key];
}

/** `<html lang>` を現在言語へ同期する。 */
function syncHtmlLang(): void {
  if (typeof document !== 'undefined') {
    document.documentElement.lang = current;
  }
}

/** 言語を設定し、保存・`<html lang>` 同期・購読者通知を行う。 */
export function setLang(lang: Lang): void {
  if (lang === current) return;
  current = lang;
  storeLang(lang);
  syncHtmlLang();
  for (const fn of listeners) fn();
}

/** ja ⇄ en をトグルする。 */
export function toggleLang(): void {
  setLang(current === 'ja' ? 'en' : 'ja');
}

/**
 * 言語変更を購読する。返り値を呼ぶと解除。
 * 登録直後は呼ばない（初期描画は呼び出し側が行う）。
 */
export function onLangChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// 初期化時に <html lang> を一度合わせておく。
syncHtmlLang();
