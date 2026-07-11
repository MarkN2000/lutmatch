/**
 * Worker ⇄ メインスレッド間のメッセージプロトコル（型 + 純粋ヘルパー）。
 *
 * このファイルは **DOM 非依存・副作用なし**（`self`/`postMessage`/`Worker` を一切参照しない）。
 * Node/vitest から直接 import してユニットテストできる。実際の送受信は
 * worker/match.worker.ts（Worker 側）と worker/client.ts（メイン側）が担う。
 */

import type { GenerateLutOptions } from '../core/index.ts';

// ---- フェーズ・種別 ----

/** LUT 生成リクエストの進捗フェーズ。 */
export type LutProgressPhase =
  | 'decoding-source'
  | 'decoding-reference'
  | 'matching'
  | 'finalizing';

/** .cube シリアライズリクエストの進捗フェーズ。 */
export type CubeProgressPhase = 'serializing';

/** リクエスト種別（進捗・エラーの帰属先を識別する）。 */
export type RequestKind = 'generate-lut' | 'serialize-cube';

// ---- ペイロード ----

/**
 * 転送するピクセルバッファ。
 * `buffer` は sRGB 8bit RGBA（`Uint8ClampedArray` の裏付けバッファ）。
 */
export interface PixelBufferPayload {
  buffer: ArrayBuffer;
  width: number;
  height: number;
}

/** LUT 生成リクエストのペイロード。 */
export interface GenerateLutRequestPayload {
  source: PixelBufferPayload;
  /** 省略時は恒等基底の手動 LUT 生成（自動マッチを行わない）。 */
  reference?: PixelBufferPayload;
  options: GenerateLutOptions;
}

/** LUT 生成リクエストメッセージ（メイン → Worker）。 */
export interface GenerateLutRequestMessage {
  kind: 'generate-lut';
  id: number;
  payload: GenerateLutRequestPayload;
}

/**
 * LUT 生成結果メッセージ（Worker → メイン）。`lut`/`effectiveCurves`/`histSource`/`histResult`
 * はいずれも転送された ArrayBuffer（Float32Array の裏付け）。
 *
 * ビン数（CURVE_BINS/HIST_BINS）はメッセージに含めない。呼び出し側は `core/index.ts` の
 * 共有定数 `CURVE_BINS`/`HIST_BINS` を import して使う（DRY・値の二重管理を避ける）。
 * - `effectiveCurves`：`[R|G|B|M]` の4ブロック連結・各ブロック長 `CURVE_BINS`
 * - `histSource`/`histResult`：`[R|G|B|Y']` の4ブロック連結・各ブロック長 `HIST_BINS`
 */
export interface GenerateLutResultMessage {
  kind: 'generate-lut-result';
  id: number;
  lut: ArrayBuffer;
  size: number;
  fallback: boolean;
  effectiveCurves: ArrayBuffer;
  histSource: ArrayBuffer;
  histResult: ArrayBuffer;
}

/** .cube シリアライズリクエストのペイロード。 */
export interface SerializeCubeRequestPayload {
  lut: ArrayBuffer;
  size: number;
  title: string;
}

/** .cube シリアライズリクエストメッセージ（メイン → Worker）。 */
export interface SerializeCubeRequestMessage {
  kind: 'serialize-cube';
  id: number;
  payload: SerializeCubeRequestPayload;
}

/** .cube シリアライズ結果メッセージ（Worker → メイン）。 */
export interface SerializeCubeResultMessage {
  kind: 'serialize-cube-result';
  id: number;
  text: string;
}

/** 進捗メッセージ（Worker → メイン）。 */
export interface ProgressMessage<Phase extends string = string> {
  kind: 'progress';
  requestKind: RequestKind;
  id: number;
  phase: Phase;
  ratio: number;
}

/** エラーメッセージ（Worker → メイン）。 */
export interface WorkerErrorMessage {
  kind: 'error';
  requestKind: RequestKind;
  id: number;
  message: string;
}

/** メイン → Worker のリクエスト全種。 */
export type WorkerRequestMessage = GenerateLutRequestMessage | SerializeCubeRequestMessage;

/** Worker → メイン のレスポンス全種。 */
export type WorkerResponseMessage =
  | ProgressMessage
  | GenerateLutResultMessage
  | SerializeCubeResultMessage
  | WorkerErrorMessage;

// ---- id シーケンス ----

/** 単調増加する id 発番器（1 始まり）。 */
export interface IdSequence {
  next(): number;
}

/**
 * 1 から単調増加する id 発番器を作る。
 * リクエストごとに `next()` を呼び、最新 id を「supersede（先行破棄）」判定に使う。
 */
export function createIdSequence(): IdSequence {
  let current = 0;
  return {
    next(): number {
      current += 1;
      return current;
    },
  };
}

/**
 * `messageId` が最新 id で上書き済み（＝より新しいリクエストが発行されている）かを返す。
 * true のときはこのメッセージの進捗/結果を破棄してよい。
 */
export function isSuperseded(latestId: number, messageId: number): boolean {
  return messageId !== latestId;
}

// ---- メッセージビルダー（純粋） ----

/** LUT 生成リクエストメッセージを組み立てる。 */
export function buildGenerateLutRequest(
  id: number,
  payload: GenerateLutRequestPayload,
): GenerateLutRequestMessage {
  return { kind: 'generate-lut', id, payload };
}

/** .cube シリアライズリクエストメッセージを組み立てる。 */
export function buildSerializeCubeRequest(
  id: number,
  payload: SerializeCubeRequestPayload,
): SerializeCubeRequestMessage {
  return { kind: 'serialize-cube', id, payload };
}

/** 進捗メッセージを組み立てる。 */
export function buildProgress<Phase extends string>(
  requestKind: RequestKind,
  id: number,
  phase: Phase,
  ratio: number,
): ProgressMessage<Phase> {
  return { kind: 'progress', requestKind, id, phase, ratio };
}

/** LUT 生成結果メッセージを組み立てる。 */
export function buildGenerateLutResult(
  id: number,
  lut: ArrayBuffer,
  size: number,
  fallback: boolean,
  effectiveCurves: ArrayBuffer,
  histSource: ArrayBuffer,
  histResult: ArrayBuffer,
): GenerateLutResultMessage {
  return { kind: 'generate-lut-result', id, lut, size, fallback, effectiveCurves, histSource, histResult };
}

/** .cube シリアライズ結果メッセージを組み立てる。 */
export function buildSerializeCubeResult(id: number, text: string): SerializeCubeResultMessage {
  return { kind: 'serialize-cube-result', id, text };
}

/** エラーメッセージを組み立てる。 */
export function buildErrorMessage(
  requestKind: RequestKind,
  id: number,
  message: string,
): WorkerErrorMessage {
  return { kind: 'error', requestKind, id, message };
}

// ---- 転送リスト（Transferable）ヘルパー（純粋） ----

/**
 * LUT 生成リクエストで転送すべき ArrayBuffer 列（source → reference の順）。
 * `reference`省略時（恒等基底の手動 LUT 生成）は source のみを返す。
 * 参照をそのまま返す（コピー・ラップしない）。
 */
export function generateLutRequestTransferables(
  payload: GenerateLutRequestPayload,
): ArrayBuffer[] {
  return payload.reference ? [payload.source.buffer, payload.reference.buffer] : [payload.source.buffer];
}

/**
 * LUT 生成結果で転送すべき ArrayBuffer 列
 * （lut → effectiveCurves → histSource → histResult の順で計4個）。
 * 各バッファは generateLut 内で独立確保されている前提（subarray の共有 buffer だと
 * transfer で兄弟 view が破壊されるため不可）。
 */
export function generateLutResultTransferables(msg: GenerateLutResultMessage): ArrayBuffer[] {
  return [msg.lut, msg.effectiveCurves, msg.histSource, msg.histResult];
}

/** .cube シリアライズリクエストで転送すべき ArrayBuffer 列（lut のみ）。 */
export function serializeCubeRequestTransferables(
  payload: SerializeCubeRequestPayload,
): ArrayBuffer[] {
  return [payload.lut];
}
