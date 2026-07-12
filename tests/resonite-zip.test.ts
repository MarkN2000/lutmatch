import { inflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildZip, type ZipEntry } from '../src/core/resonite/zip.ts';
import { bytesEqual, crc32, parseZip, randomBytes } from './resonite-helpers.ts';

const parse = (zip: Uint8Array) => parseZip(zip, inflateRawSync);

describe('最小 ZIP ライター', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('複数エントリを往復（名前・内容・CRC が一致）', async () => {
    const entries: ZipEntry[] = [
      { name: 'R-Main.record', data: new TextEncoder().encode('{"id":"R-Main"}') },
      { name: 'Assets/aaa', data: randomBytes(5000, 1) }, // 非圧縮性 → STORE 採用見込み
      { name: 'Assets/bbb', data: new Uint8Array(4096) }, // 全 0 → DEFLATE 採用見込み
      { name: 'Metadata/x.bitmap', data: new Uint8Array([1, 2, 3, 4, 5]) },
    ];
    const zip = await buildZip(entries);
    const parsed = parse(zip);

    expect(parsed.map((e) => e.name)).toEqual([
      'R-Main.record',
      'Assets/aaa',
      'Assets/bbb',
      'Metadata/x.bitmap',
    ]);
    for (let i = 0; i < entries.length; i++) {
      expect(bytesEqual(parsed[i].data, entries[i].data)).toBe(true);
      // セントラルディレクトリの CRC が無圧縮データの CRC と一致する。
      expect(parsed[i].crc).toBe(crc32(entries[i].data));
    }
  });

  it('圧縮可能データは DEFLATE（method 8）を採用', async () => {
    const zip = await buildZip([{ name: 'zeros', data: new Uint8Array(8192) }]);
    const parsed = parse(zip);
    expect(parsed[0].method).toBe(8);
    expect(parsed[0].data.length).toBe(8192);
  });

  it('CompressionStream 非対応環境では STORE（method 0）にフォールバック', async () => {
    vi.stubGlobal('CompressionStream', undefined);
    const data = new Uint8Array(8192); // 圧縮可能だが CS 無しなので STORE
    const zip = await buildZip([{ name: 'zeros', data }]);
    const parsed = parse(zip);
    expect(parsed[0].method).toBe(0);
    expect(bytesEqual(parsed[0].data, data)).toBe(true);
  });

  it('空エントリ配列でも有効な ZIP（EOCD のみ）', async () => {
    const zip = await buildZip([]);
    expect(parse(zip)).toEqual([]);
  });

  it('ローカルヘッダーの DOS 日付が有効値（月・日 != 0）', async () => {
    // 日付 0 は月 0・日 0 の無効 DOS 日付で一部リーダーが例外を投げるため回避する。
    const zip = await buildZip([{ name: 'a', data: new Uint8Array([1]) }]);
    const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const dosDate = dv.getUint16(12, true); // ローカルヘッダー先頭 +12 = 更新日付
    const month = (dosDate >>> 5) & 0x0f;
    const day = dosDate & 0x1f;
    expect(month).toBeGreaterThanOrEqual(1);
    expect(month).toBeLessThanOrEqual(12);
    expect(day).toBeGreaterThanOrEqual(1);
    expect(day).toBeLessThanOrEqual(31);
  });
});
