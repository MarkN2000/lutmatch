import { describe, expect, it } from 'vitest';
import { DEFAULT_TITLE, sanitizeTitle, serializeCube } from '../src/core/cube.ts';

/** サイズ N の Identity LUT（ガンマ格子）を作る。 */
function identityLut(n: number): Float32Array {
  const lut = new Float32Array(n * n * n * 3);
  const inv = 1 / (n - 1);
  let idx = 0;
  for (let b = 0; b < n; b++) {
    for (let g = 0; g < n; g++) {
      for (let r = 0; r < n; r++) {
        lut[idx++] = r * inv;
        lut[idx++] = g * inv;
        lut[idx++] = b * inv;
      }
    }
  }
  return lut;
}

describe('.cube シリアライズ', () => {
  it('ヘッダー・行数・値域・LF・6桁小数が正しい', () => {
    const n = 17;
    const text = serializeCube(identityLut(n), n, 'My LUT');
    const lines = text.split('\n');
    // ヘッダー 4 行 + データ N³ 行。
    expect(lines.length).toBe(4 + n * n * n);
    expect(lines[0]).toBe('TITLE "My LUT"');
    expect(lines[1]).toBe(`LUT_3D_SIZE ${n}`);
    expect(lines[2]).toBe('DOMAIN_MIN 0.0 0.0 0.0');
    expect(lines[3]).toBe('DOMAIN_MAX 1.0 1.0 1.0');
    // CRLF を含まない（LF 固定）。
    expect(text.includes('\r')).toBe(false);
    // 先頭データ行は 0。
    expect(lines[4]).toBe('0.000000 0.000000 0.000000');
    // 全データ行が「6 桁小数 3 個・指数表記なし」。
    for (let i = 4; i < lines.length; i++) {
      expect(lines[i]).toMatch(/^\d\.\d{6} \d\.\d{6} \d\.\d{6}$/);
    }
  });

  it('R が最速で回る（2 行目のデータは R のみ増える）', () => {
    const n = 17;
    const text = serializeCube(identityLut(n), n, 't');
    const lines = text.split('\n');
    const first = lines[4].split(' ').map(Number);
    const second = lines[5].split(' ').map(Number);
    expect(first[0]).toBe(0);
    expect(second[0]).toBeCloseTo(1 / (n - 1), 6);
    expect(second[1]).toBe(0);
    expect(second[2]).toBe(0);
  });

  it('サイズ不一致は例外', () => {
    expect(() => serializeCube(new Float32Array(10), 17, 't')).toThrow();
  });
});

describe('TITLE サニタイズ', () => {
  it('ダブルクォートとバックスラッシュを除去する', () => {
    expect(sanitizeTitle('a"b\\c')).toBe('abc');
  });

  it('印字可能 ASCII 以外（日本語）は _ に置換する', () => {
    expect(sanitizeTitle('フィルム風')).toBe('_____'); // 5 文字
    expect(sanitizeTitle('film フィルム')).toBe('film ____'); // フィルム=4 文字
  });

  it('印字可能 ASCII はそのまま保持する', () => {
    expect(sanitizeTitle('Cool_LUT-01 (v2)')).toBe('Cool_LUT-01 (v2)');
  });

  it('サニタイズ後に空なら既定名', () => {
    expect(sanitizeTitle('')).toBe(DEFAULT_TITLE);
    expect(sanitizeTitle('"\\"')).toBe(DEFAULT_TITLE);
    // 全角空白は印字可能 ASCII 以外 → '_' に置換（空にはならない）。
    expect(sanitizeTitle('　')).toBe('_');
  });
});
