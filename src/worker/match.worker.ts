/**
 * 重い計算を担う Dedicated Web Worker のエントリポイント（§3）。
 *
 * メインスレッドから
 *   `new Worker(new URL('./match.worker.ts', import.meta.url), { type: 'module' })`
 * で起動される。統計・LUT 生成・.cube シリアライズのみを担当し、
 * プレビュー描画（WebGL/Canvas2D）はメイン側の責務。
 *
 * ## `self` の型付けについて
 * tsconfig の `lib` に "DOM" と "WebWorker" が同居しているため、グローバル `self` /
 * `postMessage` / `onmessage` は両ライブラリの宣言が競合して型が曖昧になる。
 * これを避けるため、Worker グローバルを明示的に `DedicatedWorkerGlobalScope` として
 * ローカルに宣言し、以降の送受信はすべてこの `worker` 変数経由で行う（グローバルの
 * `postMessage`/`onmessage` には触れない）。
 */

import { generateLut, serializeCube, srgbToLinear } from '../core/index.ts';
import {
  buildErrorMessage,
  buildGenerateLutResult,
  buildProgress,
  buildSerializeCubeResult,
  generateLutResultTransferables,
  isSuperseded,
  type GenerateLutRequestMessage,
  type SerializeCubeRequestMessage,
  type WorkerRequestMessage,
  type WorkerResponseMessage,
} from './protocol.ts';

// DOM/WebWorker lib 競合回避：Worker グローバルを明示的に型付けする。
declare const self: DedicatedWorkerGlobalScope & typeof globalThis;

/** レスポンス送信の薄いラッパー（転送リスト付き）。 */
function post(message: WorkerResponseMessage, transfer: ArrayBuffer[] = []): void {
  self.postMessage(message, transfer);
}

// 各種別の最新リクエスト id（受信と同時に同期更新）。
// generateLut は完全同期呼び出しのため mid-flight での中断はできないが、
// 「開始前に既に古いと分かっているリクエスト」は着手前に破棄できる。
let latestGenerateLutId = 0;
let latestSerializeCubeId = 0;

/**
 * sRGB 8bit RGBA バッファをリニア RGBA `Float32Array` に変換する。
 * R/G/B は `srgbToLinear(u8/255)`、アルファは `u8/255`（ガンマ復号しない）。
 */
function srgbRgbaToLinear(buffer: ArrayBuffer): Float32Array {
  const u8 = new Uint8ClampedArray(buffer);
  const out = new Float32Array(u8.length);
  for (let i = 0; i < u8.length; i += 4) {
    out[i] = srgbToLinear(u8[i] / 255);
    out[i + 1] = srgbToLinear(u8[i + 1] / 255);
    out[i + 2] = srgbToLinear(u8[i + 2] / 255);
    out[i + 3] = u8[i + 3] / 255; // アルファはリニア化しない
  }
  return out;
}

/** LUT 生成リクエストを処理する。 */
function handleGenerateLut(msg: GenerateLutRequestMessage): void {
  const { id, payload } = msg;
  try {
    // 進捗の粒度について：generateLut は内部フックのない単一同期呼び出しのため、
    // 「呼び出し前後」より細かい進捗は出せない。フェーズは
    // decoding-source → decoding-reference → matching → finalizing の 4 段階で、
    // matching の 0.35 → finalizing の 0.95 の間が実際の重い計算区間。
    post(buildProgress('generate-lut', id, 'decoding-source', 0.05));
    const srcLinear = srgbRgbaToLinear(payload.source.buffer);

    if (isSuperseded(latestGenerateLutId, id)) return; // より新しい要求が来た → 破棄
    post(buildProgress('generate-lut', id, 'decoding-reference', 0.2));
    const refLinear = srgbRgbaToLinear(payload.reference.buffer);

    if (isSuperseded(latestGenerateLutId, id)) return;
    post(buildProgress('generate-lut', id, 'matching', 0.35));
    const result = generateLut(srcLinear, refLinear, 4, payload.options);

    if (isSuperseded(latestGenerateLutId, id)) return;
    post(buildProgress('generate-lut', id, 'finalizing', 0.95));
    // result.lut / effectiveCurves / histSource / histResult は generateLut がそれぞれ
    // 独立に新規確保するため、裏付けは常に通常の ArrayBuffer（SharedArrayBuffer は §3 で
    // 不使用）かつ subarray 共有でもない。Float32Array.buffer の型は ArrayBufferLike の
    // ため narrow する。
    const resultMsg = buildGenerateLutResult(
      id,
      result.lut.buffer as ArrayBuffer,
      result.size,
      result.fallback,
      result.effectiveCurves.buffer as ArrayBuffer,
      result.histSource.buffer as ArrayBuffer,
      result.histResult.buffer as ArrayBuffer,
    );
    post(resultMsg, generateLutResultTransferables(resultMsg));
  } catch (err) {
    post(buildErrorMessage('generate-lut', id, err instanceof Error ? err.message : String(err)));
  }
}

/** .cube シリアライズリクエストを処理する。 */
function handleSerializeCube(msg: SerializeCubeRequestMessage): void {
  const { id, payload } = msg;
  try {
    if (isSuperseded(latestSerializeCubeId, id)) return;
    post(buildProgress('serialize-cube', id, 'serializing', 0.5));
    const lut = new Float32Array(payload.lut);
    const text = serializeCube(lut, payload.size, payload.title);

    if (isSuperseded(latestSerializeCubeId, id)) return;
    post(buildSerializeCubeResult(id, text));
  } catch (err) {
    post(buildErrorMessage('serialize-cube', id, err instanceof Error ? err.message : String(err)));
  }
}

self.addEventListener('message', (event: MessageEvent<WorkerRequestMessage>): void => {
  const msg = event.data;
  switch (msg.kind) {
    case 'generate-lut':
      // 最新 id を受信と同時に更新（同一種別の先行リクエストを supersede）。
      latestGenerateLutId = msg.id;
      handleGenerateLut(msg);
      break;
    case 'serialize-cube':
      latestSerializeCubeId = msg.id;
      handleSerializeCube(msg);
      break;
  }
});
