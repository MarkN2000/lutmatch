/**
 * 素の DOM を組み立てるための最小ヘルパー群（フレームワーク不使用・DRY）。
 *
 * フレームワークを持ち込まず、型安全に要素を生成・更新するための薄いユーティリティ。
 * 各 UI コンポーネントはこれらを共有して重複を避ける。
 */

/** タグ名から要素を生成し、任意でクラス名を付与する。 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

/** 子要素・文字列をまとめて追加する。 */
export function append(parent: Node, ...children: (Node | string)[]): void {
  for (const child of children) {
    parent.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
}

/** 要素の子を全て取り除く。 */
export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/**
 * 末尾呼び出しのみを遅延実行するデバウンサを作る。
 * スライダー操作中の Worker 再計算を間引くのに使う（§7）。
 */
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  wait: number,
): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args: A): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, wait);
  };
}

/** 端末が粗いポインタ（タッチ）主体かを判定する（比較スライダー等の分岐用）。 */
export function isCoarsePointer(): boolean {
  return typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
}
