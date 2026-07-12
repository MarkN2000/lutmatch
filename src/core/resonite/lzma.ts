/**
 * 最小 LZMA エンコーダー（リテラル専用・Resonite Bmp3D 用）。
 *
 * マッチ探索を一切行わず、全バイトをリテラルとして符号化する（圧縮率より
 * 正しさと実装の小ささを優先）。生成した `props` + `stream` は LZMA "alone"
 * 形式（props 5 バイト + 無圧縮サイズ int64LE + ストリーム）に組めば標準の
 * LZMA デコーダーで復元できる。
 *
 * パラメーターは lc=3 / lp=0 / pb=2（props バイト 0x5D）、辞書サイズ 2MB
 * （0x00200000）。リテラル専用なので辞書は使わないが props としては合法値。
 *
 * レンジエンコーダーは 7-Zip の LzmaEnc.c を忠実に移植（11bit 確率モデル・
 * kTopValue=1<<24・cache/cacheSize 方式）。EOS マーカーは書かない（無圧縮
 * サイズは呼び出し側がヘッダーに別途書く）。flush（5 バイト排出）は必須。
 */

// ---- 定数（LzmaEnc.c 準拠） ----

const K_TOP_VALUE = 1 << 24;
const K_NUM_BIT_MODEL_TOTAL_BITS = 11;
const K_BIT_MODEL_TOTAL = 1 << K_NUM_BIT_MODEL_TOTAL_BITS; // 2048
const K_PROB_INIT = K_BIT_MODEL_TOTAL >> 1; // 1024
const K_NUM_MOVE_BITS = 5;
const K_NUM_POS_BITS_MAX = 4; // IsMatch のインデックス shift 幅
const K_NUM_STATES = 12;

/** リテラル context ビット数 lc。 */
const LC = 3;
/** リテラル位置ビット数 lp。 */
const LP = 0;
/** 位置ビット数 pb。 */
const PB = 2;

/** props バイト：(pb*5 + lp)*9 + lc = 0x5D。 */
const PROPS_BYTE = (PB * 5 + LP) * 9 + LC;
/** 辞書サイズ 2MB。 */
const DICT_SIZE = 0x00200000;

const POS_MASK = (1 << PB) - 1;
const LIT_POS_MASK = (1 << LP) - 1;

/**
 * レンジエンコーダー。
 * `low` は最大でも約 2^41 に収まるため通常の Number（64bit 浮動小数）で扱い、
 * 32bit を跨ぐ演算はビット演算ではなく除算・剰余で行う。
 */
class RangeEncoder {
  private low = 0; // 0 .. ~2^41
  private range = 0xffffffff;
  private cache = 0;
  private cacheSize = 1;
  private readonly out: number[] = [];

  /** 確率モデル `probs[index]` に従って 1 ビットを符号化する。 */
  encodeBit(probs: Uint16Array, index: number, bit: number): void {
    const prob = probs[index];
    const bound = (this.range >>> K_NUM_BIT_MODEL_TOTAL_BITS) * prob;
    if (bit === 0) {
      this.range = bound;
      probs[index] = prob + ((K_BIT_MODEL_TOTAL - prob) >>> K_NUM_MOVE_BITS);
    } else {
      this.low += bound;
      this.range -= bound;
      probs[index] = prob - (prob >>> K_NUM_MOVE_BITS);
    }
    // 正規化（range < 2^24 なら 1 回だけシフト）。
    if (this.range < K_TOP_VALUE) {
      this.range = this.range * 256;
      this.shiftLow();
    }
  }

  /** キャリー伝播つきに最下位バイトを排出する（LzmaEnc.c の RangeEnc_ShiftLow）。 */
  private shiftLow(): void {
    const lowU32 = this.low % 0x100000000;
    const carry = Math.floor(this.low / 0x100000000); // low >> 32（0 か 1）
    if (lowU32 < 0xff000000 || carry !== 0) {
      let temp = this.cache;
      do {
        this.out.push((temp + carry) & 0xff);
        temp = 0xff;
      } while (--this.cacheSize !== 0);
      this.cache = Math.floor(lowU32 / 0x1000000) & 0xff; // (uint32)low >> 24
    }
    this.cacheSize++;
    this.low = (lowU32 * 256) % 0x100000000; // (uint32)low << 8
  }

  /** レンジエンコーダーを排出して確定させる（5 バイト）。 */
  flush(): void {
    for (let i = 0; i < 5; i++) this.shiftLow();
  }

  /** 符号化済みバイト列を取り出す。 */
  toBytes(): Uint8Array {
    return Uint8Array.from(this.out);
  }
}

/**
 * データ全体をリテラルとして LZMA 符号化する。
 * @param data 無圧縮バイト列
 * @returns `props`（5 バイト：props バイト + 辞書サイズ LE）と `stream`（レンジ符号化列）
 */
export function lzmaCompress(data: Uint8Array): { props: Uint8Array; stream: Uint8Array } {
  const props = new Uint8Array(5);
  props[0] = PROPS_BYTE;
  props[1] = DICT_SIZE & 0xff;
  props[2] = (DICT_SIZE >>> 8) & 0xff;
  props[3] = (DICT_SIZE >>> 16) & 0xff;
  props[4] = (DICT_SIZE >>> 24) & 0xff;

  // IsMatch[state][posState]（state はリテラルのみなので常に 0）。
  const isMatch = new Uint16Array(K_NUM_STATES << K_NUM_POS_BITS_MAX).fill(K_PROB_INIT);
  // リテラル確率：0x300 << (lc + lp)。
  const litProbs = new Uint16Array(0x300 << (LC + LP)).fill(K_PROB_INIT);

  const enc = new RangeEncoder();
  const state = 0; // 直前がリテラルなので状態遷移後も 0 のまま
  let prevByte = 0;

  for (let pos = 0; pos < data.length; pos++) {
    const posState = pos & POS_MASK;
    // IsMatch ビット = 0（リテラル）。
    enc.encodeBit(isMatch, (state << K_NUM_POS_BITS_MAX) + posState, 0);
    // リテラル符号化（state < 7 なので match byte を使わない単純ビットツリー）。
    const litState = ((pos & LIT_POS_MASK) << LC) + (prevByte >>> (8 - LC));
    const base = 0x300 * litState;
    const cur = data[pos];
    let symbol = 1;
    for (let i = 7; i >= 0; i--) {
      const b = (cur >>> i) & 1;
      enc.encodeBit(litProbs, base + symbol, b);
      symbol = (symbol << 1) | b;
    }
    prevByte = cur;
  }

  enc.flush();
  return { props, stream: enc.toBytes() };
}
