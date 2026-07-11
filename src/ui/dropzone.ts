/**
 * 画像ドロップゾーン（§4.1 / §6.2）。
 *
 * ドラッグ＆ドロップとファイル選択の両対応。画像投入後はサムネイルを表示し、
 * クリックで差し替えできる。空側は誘導ハイライトを付けられる。
 */

import { append, clear, el } from './dom.ts';
import { onLangChange, t, type MessageKey } from '../i18n/index.ts';

export type DropzoneRole = 'source' | 'reference';

export interface DropzoneHandle {
  element: HTMLElement;
  /** サムネイル画像を設定（null で空状態へ戻す）。 */
  setThumbnail(bitmap: ImageBitmap | null): void;
  /** 誘導ハイライトの ON/OFF（もう一方を促す点滅）。 */
  setGuiding(guiding: boolean): void;
  /**
   * ヒント文言の差し替え（例: 「参考画像は任意」の案内）。
   * null で解除し、既定の優先順位（誘導 > 画像あり > ヒント > 既定）に戻す。
   */
  setHint(key: MessageKey | null): void;
}

const TITLE_KEY: Record<DropzoneRole, MessageKey> = {
  source: 'sourceTitle',
  reference: 'referenceTitle',
};

const GUIDE_KEY: Record<DropzoneRole, MessageKey> = {
  source: 'guideSource',
  reference: 'guideReference',
};

export function createDropzone(
  role: DropzoneRole,
  onFile: (file: File) => void,
  onRemove?: () => void,
): DropzoneHandle {
  const root = el('div', 'dropzone');
  root.dataset.role = role;
  root.setAttribute('role', 'button');
  root.tabIndex = 0;

  const title = el('div', 'dropzone__title');
  const thumbWrap = el('div', 'dropzone__thumb');
  const hint = el('div', 'dropzone__hint');
  const formats = el('div', 'dropzone__formats');

  const canvas = el('canvas', 'dropzone__canvas');

  const fileInput = el('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/jpeg,image/png,image/webp';
  fileInput.className = 'visually-hidden';

  const removeBtn = el('button', 'dropzone__remove');
  removeBtn.type = 'button';
  removeBtn.textContent = '×';

  append(root, title, thumbWrap, hint, formats, fileInput, removeBtn);

  let hasImage = false;
  let guiding = false;
  let hintKey: MessageKey | null = null;

  const refreshText = (): void => {
    title.textContent = t(TITLE_KEY[role]);
    hint.textContent = guiding
      ? t(GUIDE_KEY[role])
      : hasImage
        ? t('dropReplaceHint')
        : hintKey != null
          ? t(hintKey)
          : t('dropHint');
    formats.textContent = hasImage ? '' : t('dropFormats');
    root.setAttribute('aria-label', t(TITLE_KEY[role]));
    removeBtn.setAttribute('aria-label', t('removeImageAria'));
  };

  const pick = (): void => fileInput.click();

  root.addEventListener('click', (e) => {
    if (e.target === fileInput) return;
    pick();
  });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      pick();
    }
  });

  // 削除ボタン。root がファイル選択トリガー（role=button）を兼ねるため、
  // click/pointerdown/keydown いずれもここで止めてファイル選択ダイアログへ
  // 波及させない。
  removeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    onRemove?.();
  });
  removeBtn.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
  });
  removeBtn.addEventListener('keydown', (e) => {
    e.stopPropagation();
  });

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) onFile(file);
    fileInput.value = ''; // 同じファイル再選択を許可
  });

  // ドラッグ＆ドロップ。
  root.addEventListener('dragover', (e) => {
    e.preventDefault();
    root.classList.add('is-dragover');
  });
  root.addEventListener('dragleave', () => root.classList.remove('is-dragover'));
  root.addEventListener('drop', (e) => {
    e.preventDefault();
    root.classList.remove('is-dragover');
    const file = e.dataTransfer?.files?.[0];
    if (file) onFile(file);
  });

  onLangChange(refreshText);
  refreshText();

  return {
    element: root,
    setThumbnail(bitmap): void {
      clear(thumbWrap);
      if (bitmap) {
        // ImageBitmap をサムネイル canvas に等比縮小で描画。
        const maxEdge = 128;
        const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.imageSmoothingEnabled = true;
          ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        }
        append(thumbWrap, canvas);
        hasImage = true;
        root.classList.add('has-image');
      } else {
        hasImage = false;
        root.classList.remove('has-image');
      }
      refreshText();
    },
    setGuiding(nextGuiding): void {
      guiding = nextGuiding;
      root.classList.toggle('is-guiding', guiding);
      refreshText();
    },
    setHint(key): void {
      hintKey = key;
      refreshText();
    },
  };
}
