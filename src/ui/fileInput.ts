/**
 * ファイル入力・ドラッグ＆ドロップの共通機構（§4.1）。
 *
 * 隠しファイル入力の生成と、任意要素への画像 D&D 受付を提供する。
 * dropzone.ts / preview.ts が共有し、入力口ごとの重複を避ける（DRY）。
 */

import { el } from './dom.ts';

/** 受け付ける画像 MIME タイプ（accept 属性・§4.1）。 */
export const ACCEPT_IMAGE_TYPES = 'image/jpeg,image/png,image/webp';

export interface HiddenFileInput {
  element: HTMLInputElement;
  /** ファイル選択ダイアログを開く。 */
  open(): void;
}

/**
 * 隠しファイル入力を生成する。change で onFile を呼び、value をリセットして
 * 同一ファイルの再選択を許可する。
 */
export function createHiddenFileInput(onFile: (file: File) => void): HiddenFileInput {
  const input = el('input');
  input.type = 'file';
  input.accept = ACCEPT_IMAGE_TYPES;
  input.className = 'visually-hidden';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file) onFile(file);
    input.value = ''; // 同じファイル再選択を許可
  });
  return { element: input, open: () => input.click() };
}

export interface FileDropOptions {
  /** ドラッグ中に付与するクラス名（既定 'is-dragover'）。 */
  dragoverClass?: string;
}

/**
 * 任意要素へ画像ファイルの D&D 受付を取り付ける。dragover でクラス付与、
 * dragleave（子要素間の移動では解除しない relatedTarget 判定）でクラス解除、
 * drop で先頭ファイルを onFile へ渡す。
 */
export function attachFileDrop(
  target: HTMLElement,
  onFile: (file: File) => void,
  opts: FileDropOptions = {},
): void {
  const dragoverClass = opts.dragoverClass ?? 'is-dragover';
  target.addEventListener('dragover', (e) => {
    e.preventDefault();
    target.classList.add(dragoverClass);
  });
  target.addEventListener('dragleave', (e) => {
    // 子要素間の移動では解除しない（target 外へ出たときのみ解除）。
    if (e.relatedTarget instanceof Node && target.contains(e.relatedTarget)) return;
    target.classList.remove(dragoverClass);
  });
  target.addEventListener('drop', (e) => {
    e.preventDefault();
    target.classList.remove(dragoverClass);
    const file = e.dataTransfer?.files?.[0];
    if (file) onFile(file);
  });
}
