/**
 * Resonite コーデックテスト用の最小 Node ビルトイン型シム。
 *
 * このプロジェクトは意図的に @types/node を導入していない（src/ はブラウザ向けで、
 * Node のグローバル型が DOM の型と衝突しうるため）。テストで使う Node ビルトインの
 * ごく一部だけをここで宣言する。
 */

declare module 'node:module' {
  export function createRequire(path: string | URL): (id: string) => unknown;
}

declare module 'node:zlib' {
  export function brotliDecompressSync(buf: Uint8Array): Uint8Array;
}
