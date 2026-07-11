import { describe, expect, it } from 'vitest';
import { NEUTRAL_ADJUSTMENTS, type GenerateLutOptions } from '../src/core/index.ts';
import {
  buildErrorMessage,
  buildGenerateLutRequest,
  buildGenerateLutResult,
  buildProgress,
  buildSerializeCubeRequest,
  buildSerializeCubeResult,
  createIdSequence,
  generateLutRequestTransferables,
  generateLutResultTransferables,
  isSuperseded,
  serializeCubeRequestTransferables,
  type GenerateLutRequestPayload,
  type SerializeCubeRequestPayload,
} from '../src/worker/protocol.ts';

/** テスト用の GenerateLutOptions（中立値）。 */
const OPTIONS: GenerateLutOptions = {
  mode: 'C',
  size: 33,
  strength: 100,
  smoothing: 0,
  noiseSuppression: 0,
  manual: NEUTRAL_ADJUSTMENTS,
  sample: { alphaThreshold: 0.5, blackThreshold: 0 },
};

/** ダミーの PixelBufferPayload を作る。 */
function pixelPayload(bytes: number): { buffer: ArrayBuffer; width: number; height: number } {
  return { buffer: new ArrayBuffer(bytes), width: 2, height: 2 };
}

describe('createIdSequence', () => {
  it('1 始まりで単調増加する', () => {
    const seq = createIdSequence();
    expect(seq.next()).toBe(1);
    expect(seq.next()).toBe(2);
    expect(seq.next()).toBe(3);
  });

  it('独立したシーケンスは互いに干渉しない', () => {
    const a = createIdSequence();
    const b = createIdSequence();
    expect(a.next()).toBe(1);
    expect(a.next()).toBe(2);
    expect(b.next()).toBe(1); // b は独立して 1 から
  });
});

describe('isSuperseded', () => {
  it('id が最新と一致すれば false、異なれば true', () => {
    expect(isSuperseded(5, 5)).toBe(false); // 最新＝自分 → 有効
    expect(isSuperseded(6, 5)).toBe(true); // より新しい要求あり → 破棄
    expect(isSuperseded(5, 6)).toBe(true); // 一致しなければ常に true
    expect(isSuperseded(0, 1)).toBe(true);
  });
});

describe('リクエストビルダー', () => {
  it('buildGenerateLutRequest：kind/id/payload が正しい', () => {
    const payload: GenerateLutRequestPayload = {
      source: pixelPayload(16),
      reference: pixelPayload(16),
      options: OPTIONS,
    };
    const msg = buildGenerateLutRequest(42, payload);
    expect(msg.kind).toBe('generate-lut');
    expect(msg.id).toBe(42);
    expect(msg.payload).toBe(payload); // 参照そのまま
  });

  it('buildSerializeCubeRequest：kind/id/payload が正しい', () => {
    const payload: SerializeCubeRequestPayload = {
      lut: new ArrayBuffer(8),
      size: 2,
      title: 't',
    };
    const msg = buildSerializeCubeRequest(7, payload);
    expect(msg.kind).toBe('serialize-cube');
    expect(msg.id).toBe(7);
    expect(msg.payload).toBe(payload);
  });
});

describe('レスポンス・進捗ビルダー', () => {
  it('buildProgress：全フィールドが round-trip する', () => {
    const msg = buildProgress('generate-lut', 3, 'matching', 0.35);
    expect(msg).toEqual({
      kind: 'progress',
      requestKind: 'generate-lut',
      id: 3,
      phase: 'matching',
      ratio: 0.35,
    });
  });

  it('buildGenerateLutResult：kind/id/size/fallback と各バッファ参照', () => {
    const lut = new ArrayBuffer(12);
    const effectiveCurves = new ArrayBuffer(4 * 64 * 4);
    const histSource = new ArrayBuffer(4 * 256 * 4);
    const histResult = new ArrayBuffer(4 * 256 * 4);
    const msg = buildGenerateLutResult(9, lut, 2, true, effectiveCurves, histSource, histResult);
    expect(msg.kind).toBe('generate-lut-result');
    expect(msg.id).toBe(9);
    expect(msg.lut).toBe(lut);
    expect(msg.size).toBe(2);
    expect(msg.fallback).toBe(true);
    expect(msg.effectiveCurves).toBe(effectiveCurves); // 参照等価（コピーしていない）
    expect(msg.histSource).toBe(histSource);
    expect(msg.histResult).toBe(histResult);
  });

  it('buildSerializeCubeResult：kind/id/text が正しい', () => {
    const msg = buildSerializeCubeResult(11, 'TITLE "x"');
    expect(msg.kind).toBe('serialize-cube-result');
    expect(msg.id).toBe(11);
    expect(msg.text).toBe('TITLE "x"');
  });

  it('buildErrorMessage：kind/requestKind/id/message が正しい', () => {
    const msg = buildErrorMessage('serialize-cube', 13, 'boom');
    expect(msg.kind).toBe('error');
    expect(msg.requestKind).toBe('serialize-cube');
    expect(msg.id).toBe(13);
    expect(msg.message).toBe('boom');
  });
});

describe('転送リスト（Transferable）ヘルパー', () => {
  it('generateLutRequestTransferables：source→reference の順で参照を返す', () => {
    const source = pixelPayload(16);
    const reference = pixelPayload(16);
    const payload: GenerateLutRequestPayload = { source, reference, options: OPTIONS };
    const list = generateLutRequestTransferables(payload);
    expect(list).toHaveLength(2);
    expect(list[0]).toBe(source.buffer); // 参照等価（コピーしていない）
    expect(list[1]).toBe(reference.buffer);
  });

  it('generateLutResultTransferables：lut/effectiveCurves/histSource/histResult の4バッファを順序通り返す', () => {
    const lut = new ArrayBuffer(12);
    const effectiveCurves = new ArrayBuffer(4 * 64 * 4);
    const histSource = new ArrayBuffer(4 * 256 * 4);
    const histResult = new ArrayBuffer(4 * 256 * 4);
    const msg = buildGenerateLutResult(1, lut, 2, false, effectiveCurves, histSource, histResult);
    const list = generateLutResultTransferables(msg);
    expect(list).toHaveLength(4);
    expect(list[0]).toBe(lut);
    expect(list[1]).toBe(effectiveCurves);
    expect(list[2]).toBe(histSource);
    expect(list[3]).toBe(histResult);
  });

  it('serializeCubeRequestTransferables：lut バッファ 1 個のみ', () => {
    const lut = new ArrayBuffer(8);
    const payload: SerializeCubeRequestPayload = { lut, size: 2, title: 't' };
    const list = serializeCubeRequestTransferables(payload);
    expect(list).toHaveLength(1);
    expect(list[0]).toBe(lut);
  });
});
