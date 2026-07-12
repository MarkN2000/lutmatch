/** Resonite コーデックテスト用ユーティリティ（LZMA-JS デコード補助・決定的乱数）。 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// LZMA-JS（テスト専用 dev 依存）。バイナリは signed-byte 配列、テキストは文字列を返す。
const lzma = require('lzma') as {
  decompress: (data: Uint8Array) => Array<number | string> | string;
};

/** LZMA-JS の decompress 結果（文字列 or signed-byte 配列）を Uint8Array へ正規化する。 */
export function toBytes(res: Array<number | string> | string): Uint8Array {
  const out = new Uint8Array(res.length);
  for (let i = 0; i < res.length; i++) {
    const v = res[i];
    out[i] = typeof v === 'string' ? v.charCodeAt(0) & 0xff : v & 0xff;
  }
  return out;
}

/**
 * props(5) + 無圧縮サイズ int64LE + stream を LZMA "alone" 形式に組んで復元する。
 * @param props lzmaCompress が返す 5 バイトの props
 * @param uncompressedSize 無圧縮サイズ（バイト）
 * @param stream レンジ符号化ストリーム
 */
export function lzmaDecodeAlone(
  props: Uint8Array,
  uncompressedSize: number,
  stream: Uint8Array,
): Uint8Array {
  const alone = new Uint8Array(5 + 8 + stream.length);
  alone.set(props, 0);
  new DataView(alone.buffer).setBigUint64(5, BigInt(uncompressedSize), true);
  alone.set(stream, 13);
  return toBytes(lzma.decompress(alone));
}

/** mulberry32：シード固定の決定的擬似乱数バイト列。 */
export function randomBytes(count: number, seed: number): Uint8Array {
  let s = seed >>> 0;
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    out[i] = ((t ^ (t >>> 14)) >>> 0) & 0xff;
  }
  return out;
}

/** 2 つのバイト列が完全一致するか。 */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
