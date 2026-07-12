import { describe, expect, it } from 'vitest';
import { lzmaCompress } from '../src/core/resonite/lzma.ts';
import { bytesEqual, lzmaDecodeAlone, randomBytes } from './resonite-helpers.ts';

describe('最小 LZMA エンコーダー（リテラル専用）', () => {
  it('props は 0x5D + 辞書サイズ 2MB(LE)', () => {
    const { props } = lzmaCompress(new Uint8Array([1, 2, 3]));
    expect(Array.from(props)).toEqual([0x5d, 0x00, 0x00, 0x20, 0x00]);
  });

  it('空入力は 5 バイトの flush（全 0x00）ストリームになる', () => {
    // LZMA-JS デコーダーは無圧縮サイズ 0 を扱えないため、正準な空ストリームを直接検証する。
    const { props, stream } = lzmaCompress(new Uint8Array(0));
    expect(Array.from(props)).toEqual([0x5d, 0x00, 0x00, 0x20, 0x00]);
    expect(Array.from(stream)).toEqual([0, 0, 0, 0, 0]);
  });

  // LZMA "alone" 形式へ組んで LZMA-JS で復元 → 元データと完全一致することを検証する。
  const roundtrip = (label: string, data: Uint8Array): void => {
    it(`往復一致：${label}（${data.length}B）`, () => {
      const { props, stream } = lzmaCompress(data);
      const decoded = lzmaDecodeAlone(props, data.length, stream);
      expect(decoded.length).toBe(data.length);
      expect(bytesEqual(decoded, data)).toBe(true);
    });
  };

  roundtrip('1 バイト', new Uint8Array([0xab]));
  roundtrip('全ゼロ', new Uint8Array(4096));
  roundtrip('全 0xFF', new Uint8Array(4096).fill(0xff));
  roundtrip('ランダム 333', randomBytes(333, 1));
  roundtrip('ランダム 8192', randomBytes(8192, 2));
  roundtrip('ランダム 70000', randomBytes(70000, 3));
  roundtrip('ランダム 1MB', randomBytes(1_000_000, 4));

  it('全バイト値 0..255 を含むデータも復元できる（リテラル context 網羅）', () => {
    const data = new Uint8Array(256 * 4);
    for (let i = 0; i < data.length; i++) data[i] = i & 0xff;
    const { props, stream } = lzmaCompress(data);
    const decoded = lzmaDecodeAlone(props, data.length, stream);
    expect(bytesEqual(decoded, data)).toBe(true);
  });
});
