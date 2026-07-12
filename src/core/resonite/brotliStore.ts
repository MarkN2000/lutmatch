/**
 * store-only Brotli エンコーダー（RFC 7932 非圧縮メタブロック）。
 *
 * データを一切圧縮せず、非圧縮メタブロックの連結として合法な Brotli ストリームを
 * 生成する。Resonite の FrDT アセットが Brotli を要求するため、依存を増やさずに
 * ブラウザ内で「格納のみ」の Brotli を作るのに使う。標準の Brotli デコーダー
 * （Node の zlib.brotliDecompressSync 等）でそのまま復元できる。
 *
 * 構成：WBITS ヘッダー（22）→ 最大 2^24-1 バイトごとに非圧縮メタブロック
 * （ISLAST=0, MNIBBLES, MLEN-1, ISUNCOMPRESSED=1, バイト境界へアライン, 生データ）
 * → ISLAST=1 / ISLASTEMPTY=1 の空メタブロックで終端。ビット詰めは LSB-first。
 */

/** 非圧縮メタブロック 1 個あたりの最大長（2^24 - 1）。 */
const MAX_CHUNK = 0xffffff;

/** 複数の Uint8Array を連結する。 */
function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/**
 * LSB-first のビットライター。
 * ビットは下位から詰め、`writeRaw` はバイト境界へアラインしてから生データを挿入する。
 */
class BitWriter {
  private readonly parts: Uint8Array[] = [];
  private acc: number[] = [];
  private cur = 0;
  private nbits = 0;

  /** 値 `v` の下位 `n` ビットを LSB-first で書き込む。 */
  writeBits(n: number, v: number): void {
    for (let i = 0; i < n; i++) {
      this.cur |= ((v >>> i) & 1) << this.nbits;
      if (++this.nbits === 8) {
        this.acc.push(this.cur);
        this.cur = 0;
        this.nbits = 0;
      }
    }
  }

  private flushAcc(): void {
    if (this.acc.length) {
      this.parts.push(Uint8Array.from(this.acc));
      this.acc = [];
    }
  }

  /** 端数ビットをバイト境界まで進める（残りビットは 0 埋め）。 */
  private align(): void {
    if (this.nbits > 0) {
      this.acc.push(this.cur);
      this.cur = 0;
      this.nbits = 0;
    }
  }

  /** バイト境界へアラインしてから生バイト列をコピーせず挿入する。 */
  writeRaw(buf: Uint8Array): void {
    this.align();
    this.flushAcc();
    this.parts.push(buf);
  }

  /** ストリームを確定して 1 本の Uint8Array にする。 */
  finish(): Uint8Array {
    this.align();
    this.flushAcc();
    return concatBytes(this.parts);
  }
}

/**
 * データを非圧縮メタブロックのみの Brotli ストリームへ格納する。
 * @param data 格納する生バイト列
 * @returns 標準 Brotli デコーダーで復元できるストリーム
 */
export function brotliStore(data: Uint8Array): Uint8Array {
  const bw = new BitWriter();
  // ストリームヘッダー：WBITS = 22 → 先頭ビット 1、続く 3 ビットに値 5（17 + 5 = 22）。
  bw.writeBits(1, 1);
  bw.writeBits(3, 5);

  // 非圧縮メタブロックを最大 MAX_CHUNK バイトずつ書く。
  let off = 0;
  while (off < data.length) {
    const len = Math.min(MAX_CHUNK, data.length - off);
    bw.writeBits(1, 0); // ISLAST = 0
    // MNIBBLES：MLEN を表すのに必要な最小ニブル数（4/5/6）。
    let nibbles: number;
    if (len <= 1 << 16) nibbles = 4;
    else if (len <= 1 << 20) nibbles = 5;
    else nibbles = 6;
    bw.writeBits(2, nibbles - 4); // size_nibbles コード（0/1/2）
    bw.writeBits(nibbles * 4, len - 1); // MLEN-1（LSB-first）
    bw.writeBits(1, 1); // ISUNCOMPRESSED = 1
    bw.writeRaw(data.subarray(off, off + len)); // バイト境界へアラインして生データ
    off += len;
  }

  // 終端：空の最終メタブロック。
  bw.writeBits(1, 1); // ISLAST = 1
  bw.writeBits(1, 1); // ISLASTEMPTY = 1
  return bw.finish();
}
