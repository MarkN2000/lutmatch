import { brotliDecompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { brotliStore } from '../src/core/resonite/brotliStore.ts';
import { bytesEqual, randomBytes } from './resonite-helpers.ts';

describe('store-only Brotli エンコーダー', () => {
  it('ストリーム先頭は WBITS=22 ヘッダー', () => {
    const enc = brotliStore(new Uint8Array([1]));
    // WBITS=22 → 先頭ビット 1 + 3 ビット値 5 = 下位 4 ビットが 0b1011 = 0x0B。
    expect(enc[0] & 0x0f).toBe(0x0b);
  });

  // 標準 Brotli デコーダー（node:zlib）との往復を検証する。
  const roundtrip = (label: string, data: Uint8Array): void => {
    it(`往復一致：${label}（${data.length}B）`, () => {
      const enc = brotliStore(data);
      const back = brotliDecompressSync(enc);
      expect(back.length).toBe(data.length);
      expect(bytesEqual(back, data)).toBe(true);
    });
  };

  roundtrip('空', new Uint8Array(0));
  roundtrip('1 バイト', new Uint8Array([0xab]));
  roundtrip('数 KB', randomBytes(4096, 11));
  roundtrip('境界 64KiB', randomBytes(1 << 16, 12));
  roundtrip('境界 64KiB+1', randomBytes((1 << 16) + 1, 13));
  // 17MB：単一メタブロックの上限(2^24-1)を越えチャンク分割経路を通す。
  roundtrip('17MB（チャンク分割）', randomBytes(17 * 1024 * 1024, 14));
});
