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

/** CRC-32（IEEE・zip.ts と同一多項式）。テストでヘッダーの CRC 値を独立検証する。 */
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    let x = (c ^ data[i]) & 0xff;
    for (let k = 0; k < 8; k++) x = x & 1 ? 0xedb88320 ^ (x >>> 1) : x >>> 1;
    c = x ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** parseZip が返す 1 エントリ（展開済みデータ・宣言 CRC・圧縮方式）。 */
export interface ParsedZipEntry {
  name: string;
  method: number;
  crc: number;
  data: Uint8Array;
}

/**
 * 最小 ZIP パーサ。セントラルディレクトリを辿り、DEFLATE は node:zlib で展開する。
 * @param zip ZIP バイト列
 * @param inflateRaw method 8 を展開する関数（node:zlib.inflateRawSync 等）
 */
export function parseZip(
  zip: Uint8Array,
  inflateRaw: (buf: Uint8Array) => Uint8Array,
): ParsedZipEntry[] {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  // EOCD を末尾から探す。
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('EOCD が見つからない');
  const total = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const td = new TextDecoder();
  const entries: ParsedZipEntry[] = [];
  for (let e = 0; e < total; e++) {
    if (dv.getUint32(off, true) !== 0x02014b50) throw new Error('セントラルディレクトリ署名不正');
    const method = dv.getUint16(off + 10, true);
    const crc = dv.getUint32(off + 16, true);
    const compSize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    const localOff = dv.getUint32(off + 42, true);
    const name = td.decode(zip.subarray(off + 46, off + 46 + nameLen));
    if (dv.getUint32(localOff, true) !== 0x04034b50) throw new Error('ローカル署名不正');
    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const comp = zip.subarray(dataStart, dataStart + compSize);
    const data = method === 8 ? new Uint8Array(inflateRaw(comp)) : new Uint8Array(comp);
    entries.push({ name, method, crc, data });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
