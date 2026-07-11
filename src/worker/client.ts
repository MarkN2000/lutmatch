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
  type RequestKind,
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

// ---- 堅牢性パラメータ ----

/**
 * リクエストのタイムアウト（ms）。error イベントが飛ばずに Worker が沈黙した場合の
 * セーフティネット。巨大画像でも計算しきれるよう余裕を持たせている。
 */
const GENERATE_LUT_TIMEOUT_MS = 60_000;
const SERIALIZE_CUBE_TIMEOUT_MS = 30_000;

/**
 * 再起動の暴走防止：直近 `RESTART_WINDOW_MS` の間に `MAX_RESTARTS_IN_WINDOW` 回
 * 再起動したら、以後は再起動せず保留を reject するのみとする（fatal 状態）。
 */
const RESTART_WINDOW_MS = 10_000;
const MAX_RESTARTS_IN_WINDOW = 3;

/** LUT 生成の解決値。 */
export interface GenerateLutClientResult {
  lut: Float32Array;
  size: number;
  fallback: boolean;
  /** 実効（記述的）カーブ F。`[R|G|B|M]` の4ブロック連結・各ブロック長 CURVE_BINS（§5.7）。 */
  effectiveCurves: Float32Array;
  /** Source のガンマ空間ヒストグラム。`[R|G|B|Y']` の4ブロック連結・各ブロック長 HIST_BINS。 */
  histSource: Float32Array;
  /** 結果（最終 LUT 通過後）のガンマ空間ヒストグラム。同上の形状。 */
  histResult: Float32Array;
}

/** 保留中の LUT 生成リクエスト。 */
interface PendingGenerateLut {
  id: number;
  resolve(value: GenerateLutClientResult): void;
  reject(reason: unknown): void;
  onProgress?: (phase: LutProgressPhase, ratio: number) => void;
  /** タイムアウト用タイマー（解決/破棄時に必ず解除する）。 */
  timer: ReturnType<typeof setTimeout>;
}

/** 保留中の .cube シリアライズリクエスト。 */
interface PendingSerializeCube {
  id: number;
  resolve(value: string): void;
  reject(reason: unknown): void;
  onProgress?: (phase: CubeProgressPhase, ratio: number) => void;
  /** タイムアウト用タイマー（解決/破棄時に必ず解除する）。 */
  timer: ReturnType<typeof setTimeout>;
}

/** match.worker.ts を起動しリクエストを仲介するクライアント。 */
export class MatchWorkerClient {
  // 再起動で差し替えるため readonly ではない。`spawnWorker()` で必ず初期化される。
  private worker!: Worker;
  private readonly ids: IdSequence = createIdSequence();

  // 種別ごとに「同時に 1 件だけ」保留する（新規呼び出しは先行を supersede）。
  private pendingGenerateLut: PendingGenerateLut | null = null;
  private pendingSerializeCube: PendingSerializeCube | null = null;

  // dispose 済みなら再起動しない。
  private disposed = false;
  // 短時間に再起動が連続したら諦める（fatal）。それ以降の呼び出しは即 reject。
  private fatal = false;
  // 直近の再起動時刻（暴走検知用の時刻リスト）。
  private restartTimestamps: number[] = [];

  constructor() {
    this.spawnWorker();
  }

  /** Worker を生成しハンドラを登録する（コンストラクタと再起動で共用）。 */
  private spawnWorker(): void {
    this.worker = new Worker(new URL('./match.worker.ts', import.meta.url), { type: 'module' });
    this.worker.addEventListener('message', this.handleMessage);
    this.worker.addEventListener('error', this.handleWorkerError);
    this.worker.addEventListener('messageerror', this.handleWorkerError);
  }

  /** 現行 Worker のハンドラを解除して終了する。 */
  private teardownWorker(): void {
    this.worker.removeEventListener('message', this.handleMessage);
    this.worker.removeEventListener('error', this.handleWorkerError);
    this.worker.removeEventListener('messageerror', this.handleWorkerError);
    this.worker.terminate();
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
    if (this.disposed || this.fatal) {
      return Promise.reject(new Error('Worker が停止しているため処理できません'));
    }
    // 先行の LUT 生成を破棄（タイマーも解除）。
    if (this.pendingGenerateLut) {
      clearTimeout(this.pendingGenerateLut.timer);
      this.pendingGenerateLut.reject(new SupersededError());
      this.pendingGenerateLut = null;
    }
    const id = this.ids.next();
    const message = buildGenerateLutRequest(id, payload);
    return new Promise<GenerateLutClientResult>((resolve, reject) => {
      const timer = setTimeout(
        () => this.handleTimeout('generate-lut', id),
        GENERATE_LUT_TIMEOUT_MS,
      );
      this.pendingGenerateLut = { id, resolve, reject, onProgress, timer };
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
    if (this.disposed || this.fatal) {
      return Promise.reject(new Error('Worker が停止しているため処理できません'));
    }
    if (this.pendingSerializeCube) {
      clearTimeout(this.pendingSerializeCube.timer);
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
      const timer = setTimeout(
        () => this.handleTimeout('serialize-cube', id),
        SERIALIZE_CUBE_TIMEOUT_MS,
      );
      this.pendingSerializeCube = { id, resolve, reject, onProgress, timer };
      this.worker.postMessage(message, serializeCubeRequestTransferables(payload));
    });
  }

  /** Worker を終了し保留中を全て reject する（以後は再起動しない）。 */
  dispose(): void {
    this.disposed = true;
    this.rejectAll(new Error('Worker が破棄されました'));
    this.teardownWorker();
  }

  /** 保留中を全て指定理由で reject する（タイマーも解除）。 */
  private rejectAll(reason: unknown): void {
    if (this.pendingGenerateLut) {
      clearTimeout(this.pendingGenerateLut.timer);
      const p = this.pendingGenerateLut;
      this.pendingGenerateLut = null;
      p.reject(reason);
    }
    if (this.pendingSerializeCube) {
      clearTimeout(this.pendingSerializeCube.timer);
      const p = this.pendingSerializeCube;
      this.pendingSerializeCube = null;
      p.reject(reason);
    }
  }

  /**
   * error / messageerror ハンドラ。保留を reject して Worker を自己回復させる。
   */
  private readonly handleWorkerError = (event: Event): void => {
    const reason =
      event instanceof ErrorEvent && event.message
        ? new Error(event.message)
        : new Error('Worker でエラーが発生しました');
    this.restartWorker(reason);
  };

  /**
   * リクエストのタイムアウト処理。該当保留がまだ生きていれば reject し、
   * 沈黙した Worker を作り直す。既に解決/破棄済み（id 不一致）なら誤発火として無視。
   */
  private handleTimeout(kind: RequestKind, id: number): void {
    if (kind === 'generate-lut') {
      const p = this.pendingGenerateLut;
      if (!p || p.id !== id) return;
      this.pendingGenerateLut = null;
      p.reject(new Error('LUT 生成がタイムアウトしました'));
    } else {
      const p = this.pendingSerializeCube;
      if (!p || p.id !== id) return;
      this.pendingSerializeCube = null;
      p.reject(new Error('.cube シリアライズがタイムアウトしました'));
    }
    // 応答しない Worker を作り直す（残る別種別の保留も reject）。
    this.restartWorker(new Error('Worker が応答しないため再起動しました'));
  }

  /**
   * 保留を全て reject し、現行 Worker を破棄して新しい Worker を起動する。
   * dispose 済みなら何もしない。短時間に再起動が連続した場合は fatal 状態にして
   * それ以上の再起動を止める（暴走防止）。id 発番器（this.ids）は継続するため
   * id は単調増加のまま保たれる。
   */
  private restartWorker(reason: unknown): void {
    if (this.disposed || this.fatal) {
      // fatal でも念のため保留は片付ける。
      this.rejectAll(reason);
      return;
    }
    this.rejectAll(reason);
    this.teardownWorker();

    const now = Date.now();
    this.restartTimestamps = this.restartTimestamps.filter((t) => now - t < RESTART_WINDOW_MS);
    if (this.restartTimestamps.length >= MAX_RESTARTS_IN_WINDOW) {
      // 連続失敗 → 再起動を諦める。以後の generateLut/serializeCube は即 reject。
      this.fatal = true;
      return;
    }
    this.restartTimestamps.push(now);
    this.spawnWorker();
  }

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
          clearTimeout(p.timer);
          this.pendingGenerateLut = null;
          p.resolve({
            lut: new Float32Array(msg.lut),
            size: msg.size,
            fallback: msg.fallback,
            effectiveCurves: new Float32Array(msg.effectiveCurves),
            histSource: new Float32Array(msg.histSource),
            histResult: new Float32Array(msg.histResult),
          });
        }
        break;
      }
      case 'serialize-cube-result': {
        const p = this.pendingSerializeCube;
        if (p && !isSuperseded(p.id, msg.id)) {
          clearTimeout(p.timer);
          this.pendingSerializeCube = null;
          p.resolve(msg.text);
        }
        break;
      }
      case 'error': {
        if (msg.requestKind === 'generate-lut') {
          const p = this.pendingGenerateLut;
          if (p && !isSuperseded(p.id, msg.id)) {
            clearTimeout(p.timer);
            this.pendingGenerateLut = null;
            p.reject(new Error(msg.message));
          }
        } else {
          const p = this.pendingSerializeCube;
          if (p && !isSuperseded(p.id, msg.id)) {
            clearTimeout(p.timer);
            this.pendingSerializeCube = null;
            p.reject(new Error(msg.message));
          }
        }
        break;
      }
    }
  };
}
