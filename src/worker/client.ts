/**
 * メインスレッド側の型付き Worker ラッパー（§3 / §6.2）。
 *
 * `MatchWorkerClient` は match.worker.ts を起動し、Promise ベースで
 * LUT 生成 / .cube シリアライズを実行する。進捗はコールバックで通知する。
 *
 * ## supersede（先行破棄）セマンティクス
 * 同一種別（generate-lut / serialize-cube）で保留中の呼び出しがあるうちに
 * 同じ種別を再度呼ぶと、先行 Promise は `SupersededError` で reject される。
 * 種別は独立（LUT 生成が .cube シリアライズを破棄することはない）。
 * さらに、id が最新でないレスポンスは防御的に無視する。
 */

import {
  buildGenerateLutRequest,
  buildSerializeCubeRequest,
  createIdSequence,
  generateLutRequestTransferables,
  isSuperseded,
  serializeCubeRequestTransferables,
  type CubeProgressPhase,
  type GenerateLutRequestPayload,
  type IdSequence,
  type LutProgressPhase,
  type SerializeCubeRequestPayload,
  type WorkerResponseMessage,
} from './protocol.ts';

/** 先行リクエストが後続リクエストに置き換えられたことを示すエラー。 */
export class SupersededError extends Error {
  constructor(message = 'リクエストが後続の呼び出しに置き換えられました') {
    super(message);
    this.name = 'SupersededError';
  }
}

/** LUT 生成の解決値。 */
export interface GenerateLutClientResult {
  lut: Float32Array;
  size: number;
  fallback: boolean;
}

/** 保留中の LUT 生成リクエスト。 */
interface PendingGenerateLut {
  id: number;
  resolve(value: GenerateLutClientResult): void;
  reject(reason: unknown): void;
  onProgress?: (phase: LutProgressPhase, ratio: number) => void;
}

/** 保留中の .cube シリアライズリクエスト。 */
interface PendingSerializeCube {
  id: number;
  resolve(value: string): void;
  reject(reason: unknown): void;
  onProgress?: (phase: CubeProgressPhase, ratio: number) => void;
}

/** match.worker.ts を起動しリクエストを仲介するクライアント。 */
export class MatchWorkerClient {
  private readonly worker: Worker;
  private readonly ids: IdSequence = createIdSequence();

  // 種別ごとに「同時に 1 件だけ」保留する（新規呼び出しは先行を supersede）。
  private pendingGenerateLut: PendingGenerateLut | null = null;
  private pendingSerializeCube: PendingSerializeCube | null = null;

  constructor() {
    this.worker = new Worker(new URL('./match.worker.ts', import.meta.url), { type: 'module' });
    this.worker.addEventListener('message', this.handleMessage);
    this.worker.addEventListener('error', this.handleWorkerError);
    this.worker.addEventListener('messageerror', this.handleWorkerError);
  }

  /**
   * LUT を生成する。保留中の LUT 生成があれば `SupersededError` で reject する。
   * @param payload source/reference ピクセルバッファ + オプション
   * @param onProgress 進捗コールバック（フェーズ・比率）
   */
  generateLut(
    payload: GenerateLutRequestPayload,
    onProgress?: (phase: LutProgressPhase, ratio: number) => void,
  ): Promise<GenerateLutClientResult> {
    // 先行の LUT 生成を破棄。
    if (this.pendingGenerateLut) {
      this.pendingGenerateLut.reject(new SupersededError());
      this.pendingGenerateLut = null;
    }
    const id = this.ids.next();
    const message = buildGenerateLutRequest(id, payload);
    return new Promise<GenerateLutClientResult>((resolve, reject) => {
      this.pendingGenerateLut = { id, resolve, reject, onProgress };
      this.worker.postMessage(message, generateLutRequestTransferables(payload));
    });
  }

  /**
   * LUT を .cube テキストへシリアライズする。保留中があれば `SupersededError` で reject。
   * @param lut LUT データ（size³×3・ガンマ RGB）
   * @param size 格子解像度
   * @param title TITLE 名（Worker 側でサニタイズ）
   * @param onProgress 進捗コールバック
   */
  serializeCube(
    lut: Float32Array,
    size: number,
    title: string,
    onProgress?: (phase: CubeProgressPhase, ratio: number) => void,
  ): Promise<string> {
    if (this.pendingSerializeCube) {
      this.pendingSerializeCube.reject(new SupersededError());
      this.pendingSerializeCube = null;
    }
    const id = this.ids.next();
    // lut.buffer を転送するため、呼び出し後は lut が使えなくなる点に注意。
    // Float32Array.buffer は ArrayBufferLike 型だが SharedArrayBuffer は不使用（§3）のため narrow。
    const payload: SerializeCubeRequestPayload = {
      lut: lut.buffer as ArrayBuffer,
      size,
      title,
    };
    const message = buildSerializeCubeRequest(id, payload);
    return new Promise<string>((resolve, reject) => {
      this.pendingSerializeCube = { id, resolve, reject, onProgress };
      this.worker.postMessage(message, serializeCubeRequestTransferables(payload));
    });
  }

  /** Worker を終了し保留中を全て reject する。 */
  dispose(): void {
    const err = new Error('Worker が破棄されました');
    this.rejectAll(err);
    this.worker.removeEventListener('message', this.handleMessage);
    this.worker.removeEventListener('error', this.handleWorkerError);
    this.worker.removeEventListener('messageerror', this.handleWorkerError);
    this.worker.terminate();
  }

  /** 保留中を全て指定理由で reject する。 */
  private rejectAll(reason: unknown): void {
    if (this.pendingGenerateLut) {
      this.pendingGenerateLut.reject(reason);
      this.pendingGenerateLut = null;
    }
    if (this.pendingSerializeCube) {
      this.pendingSerializeCube.reject(reason);
      this.pendingSerializeCube = null;
    }
  }

  private readonly handleWorkerError = (event: Event): void => {
    const reason =
      event instanceof ErrorEvent && event.message
        ? new Error(event.message)
        : new Error('Worker でエラーが発生しました');
    this.rejectAll(reason);
  };

  private readonly handleMessage = (event: MessageEvent<WorkerResponseMessage>): void => {
    const msg = event.data;
    switch (msg.kind) {
      case 'progress': {
        if (msg.requestKind === 'generate-lut') {
          const p = this.pendingGenerateLut;
          if (p && !isSuperseded(p.id, msg.id)) {
            p.onProgress?.(msg.phase as LutProgressPhase, msg.ratio);
          }
        } else {
          const p = this.pendingSerializeCube;
          if (p && !isSuperseded(p.id, msg.id)) {
            p.onProgress?.(msg.phase as CubeProgressPhase, msg.ratio);
          }
        }
        break;
      }
      case 'generate-lut-result': {
        const p = this.pendingGenerateLut;
        // 最新 id のレスポンスのみ受理（防御的重複チェック）。
        if (p && !isSuperseded(p.id, msg.id)) {
          this.pendingGenerateLut = null;
          p.resolve({ lut: new Float32Array(msg.lut), size: msg.size, fallback: msg.fallback });
        }
        break;
      }
      case 'serialize-cube-result': {
        const p = this.pendingSerializeCube;
        if (p && !isSuperseded(p.id, msg.id)) {
          this.pendingSerializeCube = null;
          p.resolve(msg.text);
        }
        break;
      }
      case 'error': {
        if (msg.requestKind === 'generate-lut') {
          const p = this.pendingGenerateLut;
          if (p && !isSuperseded(p.id, msg.id)) {
            this.pendingGenerateLut = null;
            p.reject(new Error(msg.message));
          }
        } else {
          const p = this.pendingSerializeCube;
          if (p && !isSuperseded(p.id, msg.id)) {
            this.pendingSerializeCube = null;
            p.reject(new Error(msg.message));
          }
        }
        break;
      }
    }
  };
}
