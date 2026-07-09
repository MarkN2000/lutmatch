/**
 * プレビューレンダラー（§4.5 / §6.3 / §7）。
 *
 * 主経路は **WebGL2 の 3D テクスチャ**：LUT（ガンマ空間→ガンマ空間の写像・
 * R 最速の Float32Array）を 3D テクスチャに格納し、フラグメントシェーダーで
 * 元画像テクスチャの色をトリリニア補間で変換して描画する。比較スライダー・
 * 表示モード・ビュー変換（コンテナへのフィット表示）を uniform で受け取り
 * 1 パスで描く。
 *
 * `webglcontextlost` / `webglcontextrestored` をハンドリングし、復旧に失敗
 * または WebGL2 が使えない場合は **Canvas 2D フォールバック**（src/core の
 * `trilinearSample` による CPU 変換＋段階的レンダリング）へ自動切替する。
 *
 * ## LUT テクスチャの形式：RGB16F を採用
 * WebGL2 では RGB16F は**コア仕様でテクスチャフィルタ可能**（LINEAR 補間が
 * 拡張なしで保証される。32bit float の RGB32F は `OES_texture_float_linear`
 * が必要でモバイルで不安定）。half-float は約 11bit 仮数を持ち、RGBA8（8bit）
 * に比べて格子値の量子化バンディングを避けられる。LUT データは既に
 * `Float32Array`（RGB・R 最速）なので、`texImage3D(..., RGB, FLOAT, lut)` で
 * **再パックなしにそのまま**アップロードできる（3D テクスチャの width=R /
 * height=G / depth=B 軸の並びが LUT のメモリ配置と一致するため）。
 * RGBA8 は互換性の最終手段だが、本アプリは WebGL2 を主経路とし、非対応環境は
 * Canvas 2D フォールバックが受け持つため、精度優先で RGB16F を選ぶ。
 */

import { trilinearSample } from '../core/index.ts';
import type { Vec3 } from '../core/index.ts';
import {
  backingStoreSize,
  clampDevicePixelRatio,
  clampSplit,
  DRAFT_LONG_EDGE,
  FULL_LONG_EDGE,
  IDENTITY_TRANSFORM,
  lutHalfTexel,
  workingSize,
} from './preview-math.ts';

/** 描画バックエンド種別。 */
export type PreviewBackend = 'webgl2' | 'canvas2d';

/** 表示モード（§4.5 タブ）。 */
export type PreviewViewMode = 'original' | 'result' | 'compare';

/** 描画品質（Canvas 2D の段階的レンダリング用・§7）。 */
export type RenderQuality = 'draft' | 'full';

/** バックエンド切替の通知コールバック。 */
export type BackendChangeCallback = (backend: PreviewBackend) => void;

/** プレビューレンダラーの公開 API。 */
export interface PreviewRenderer {
  /** 元画像を差し替える（既存 ImageBitmap の close は呼び出し側の責務）。 */
  setImage(bitmap: ImageBitmap | null): void;
  /** LUT を差し替える（Float32Array・長さ size³×3・R 最速・ガンマ RGB）。 */
  setLut(lut: Float32Array, size: number): void;
  /** LUT 適用の ON/OFF（OFF なら元画像をそのまま表示）。 */
  setLutEnabled(enabled: boolean): void;
  /** 比較スライダーの split 位置（0–1・キャンバス幅に対する割合）。 */
  setSplit(x: number): void;
  /** 表示モードを切り替える。 */
  setViewMode(mode: PreviewViewMode): void;
  /** ビュー変換（CSS px/画像 px のスケールと画像左上の CSS オフセット）。 */
  setViewTransform(scale: number, offsetX: number, offsetY: number): void;
  /** 再描画する。Canvas 2D では quality により解像度を段階制御する。 */
  render(quality?: RenderQuality): void;
  /** キャンバス CSS サイズ変更時にバッキングストア解像度を更新して再描画する。 */
  resize(): void;
  /** リソースを解放する。 */
  dispose(): void;
  /** バックエンド切替（フォールバック発生）の通知を登録する。 */
  onBackendChange(cb: BackendChangeCallback): void;
  /** 現在のバックエンド。 */
  readonly backend: PreviewBackend;
}

/** 全バックエンドが共有するレンダリング状態。 */
interface PreviewState {
  image: ImageBitmap | null;
  lut: Float32Array | null;
  lutSize: number;
  lutEnabled: boolean;
  split: number;
  viewMode: PreviewViewMode;
  scale: number;
  offsetX: number;
  offsetY: number;
}

function viewModeToInt(m: PreviewViewMode): number {
  return m === 'original' ? 0 : m === 'result' ? 1 : 2;
}

// ---- シェーダー（GLSL ES 3.00） ----

const VERT_SRC = `#version 300 es
layout(location = 0) in vec2 a_uv;
uniform vec2 u_imageSize;    // 画像ピクセルサイズ
uniform float u_scaleDev;    // デバイス px / 画像 px
uniform vec2 u_offsetDev;    // 画像左上のデバイス px オフセット
uniform vec2 u_canvasSize;   // キャンバスのデバイス px サイズ
out vec2 v_uv;
void main() {
  // 画像の四隅（a_uv∈{0,1}²）をデバイス px → クリップ空間へ写す。
  vec2 devPx = a_uv * u_imageSize * u_scaleDev + u_offsetDev;
  vec2 clip = devPx / u_canvasSize * 2.0 - 1.0;
  clip.y = -clip.y;            // 上下反転（画面上端を y=+1 に）
  gl_Position = vec4(clip, 0.0, 1.0);
  v_uv = a_uv;
}`;

const FRAG_SRC = `#version 300 es
precision highp float;
precision highp sampler3D;
uniform sampler2D u_image;
uniform sampler3D u_lut;
uniform float u_lutScale;    // (N-1)/N
uniform float u_lutOffset;   // 0.5/N
uniform bool u_lutEnabled;
uniform int u_viewMode;      // 0=original 1=result 2=compare
uniform float u_split;       // 0..1
uniform float u_canvasW;     // キャンバス幅（デバイス px）
in vec2 v_uv;
out vec4 fragColor;

vec3 applyLut(vec3 c) {
  // 半テクセルオフセットを適用してトリリニア補間（GPU の LINEAR フィルタ）。
  vec3 uvw = clamp(c, 0.0, 1.0) * u_lutScale + u_lutOffset;
  return texture(u_lut, uvw).rgb;
}

void main() {
  // 画像は sRGB（ガンマ）値をそのまま保持。LUT がガンマ空間写像なのでリニア化しない。
  vec3 src = texture(u_image, v_uv).rgb;
  vec3 dst = u_lutEnabled ? applyLut(src) : src;
  vec3 outc;
  if (u_viewMode == 0) {
    outc = src;
  } else if (u_viewMode == 1) {
    outc = dst;
  } else {
    float sx = gl_FragCoord.x / u_canvasW;   // 画面横位置（0..1）
    outc = sx < u_split ? src : dst;          // 左=適用前 / 右=適用後
  }
  fragColor = vec4(outc, 1.0);
}`;

const UNIFORM_NAMES = [
  'u_imageSize',
  'u_scaleDev',
  'u_offsetDev',
  'u_canvasSize',
  'u_image',
  'u_lut',
  'u_lutScale',
  'u_lutOffset',
  'u_lutEnabled',
  'u_viewMode',
  'u_split',
  'u_canvasW',
] as const;

type UniformName = (typeof UNIFORM_NAMES)[number];
type UniformMap = Record<UniformName, WebGLUniformLocation | null>;

/**
 * プレビューレンダラーを生成する。
 * @param canvas 描画先キャンバス
 */
export function createPreviewRenderer(canvas: HTMLCanvasElement): PreviewRenderer {
  return new PreviewRendererImpl(canvas);
}

class PreviewRendererImpl implements PreviewRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly state: PreviewState = {
    image: null,
    lut: null,
    lutSize: 0,
    lutEnabled: true,
    split: 0.5,
    viewMode: 'compare',
    scale: IDENTITY_TRANSFORM.scale,
    offsetX: IDENTITY_TRANSFORM.offsetX,
    offsetY: IDENTITY_TRANSFORM.offsetY,
  };

  private backendKind: PreviewBackend = 'webgl2';
  private readonly backendCbs: BackendChangeCallback[] = [];
  private dpr = clampDevicePixelRatio(
    typeof window !== 'undefined' ? window.devicePixelRatio : 1,
  );
  private disposed = false;

  // ---- WebGL リソース ----
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private uniforms: UniformMap | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private quadBuffer: WebGLBuffer | null = null;
  private imageTex: WebGLTexture | null = null;
  private lutTex: WebGLTexture | null = null;
  private contextLost = false;
  private readonly onLost = (e: Event): void => {
    e.preventDefault();
    this.contextLost = true;
  };
  private readonly onRestored = (): void => {
    try {
      this.initWebGL();
      this.contextLost = false;
      this.render();
    } catch {
      this.switchToCanvas2D();
    }
  };

  // ---- Canvas 2D フォールバックのリソース／キャッシュ ----
  private ctx2d: CanvasRenderingContext2D | null = null;
  private srcCanvas: HTMLCanvasElement | null = null;
  private srcCtx: CanvasRenderingContext2D | null = null;
  private resultCanvas: HTMLCanvasElement | null = null;
  private resultCtx: CanvasRenderingContext2D | null = null;
  private srcImageData: ImageData | null = null;
  private resultImageData: ImageData | null = null;
  private workW = 0;
  private workH = 0;
  private cachedLongEdge = 0;
  private sourceDirty = true; // 元画像/作業解像度が変わった → source 再取得が必要
  private resultDirty = true; // LUT/enabled が変わった → result 再計算が必要

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    canvas.addEventListener('webglcontextlost', this.onLost, false);
    canvas.addEventListener('webglcontextrestored', this.onRestored, false);

    if (!this.tryInitWebGL()) {
      this.switchToCanvas2D();
    }
    this.resize();
  }

  get backend(): PreviewBackend {
    return this.backendKind;
  }

  // ================= 公開 API =================

  setImage(bitmap: ImageBitmap | null): void {
    this.state.image = bitmap;
    if (this.backendKind === 'webgl2') {
      this.uploadImageTexture();
    } else {
      this.sourceDirty = true;
      this.resultDirty = true;
    }
  }

  setLut(lut: Float32Array, size: number): void {
    this.state.lut = lut;
    this.state.lutSize = size;
    if (this.backendKind === 'webgl2') {
      this.uploadLutTexture();
    } else {
      this.resultDirty = true;
    }
  }

  setLutEnabled(enabled: boolean): void {
    if (this.state.lutEnabled === enabled) return;
    this.state.lutEnabled = enabled;
    if (this.backendKind === 'canvas2d') this.resultDirty = true;
  }

  setSplit(x: number): void {
    this.state.split = clampSplit(x);
  }

  setViewMode(mode: PreviewViewMode): void {
    this.state.viewMode = mode;
  }

  setViewTransform(scale: number, offsetX: number, offsetY: number): void {
    this.state.scale = scale;
    this.state.offsetX = offsetX;
    this.state.offsetY = offsetY;
  }

  render(quality: RenderQuality = 'full'): void {
    if (this.disposed) return;
    if (this.backendKind === 'webgl2') {
      if (this.contextLost || !this.gl) return;
      this.renderWebGL();
    } else {
      this.renderCanvas2D(quality);
    }
  }

  resize(): void {
    if (this.disposed) return;
    this.dpr = clampDevicePixelRatio(
      typeof window !== 'undefined' ? window.devicePixelRatio : 1,
    );
    const cssW = this.canvas.clientWidth || this.canvas.width || 1;
    const cssH = this.canvas.clientHeight || this.canvas.height || 1;
    const { width, height } = backingStoreSize(cssW, cssH, this.dpr);
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    if (this.backendKind === 'webgl2' && this.gl) {
      this.gl.viewport(0, 0, width, height);
    }
    this.render();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.canvas.removeEventListener('webglcontextlost', this.onLost, false);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored, false);
    this.destroyWebGL();
    this.ctx2d = null;
    this.srcCanvas = null;
    this.srcCtx = null;
    this.resultCanvas = null;
    this.resultCtx = null;
    this.srcImageData = null;
    this.resultImageData = null;
    this.state.image = null;
    this.state.lut = null;
  }

  onBackendChange(cb: BackendChangeCallback): void {
    this.backendCbs.push(cb);
  }

  // ================= WebGL バックエンド =================

  /** WebGL2 の取得と全リソース構築を試みる。失敗時 false。 */
  private tryInitWebGL(): boolean {
    try {
      return this.initWebGL();
    } catch {
      return false;
    }
  }

  /** WebGL2 コンテキストと全リソースを（再）構築する。失敗時は throw。 */
  private initWebGL(): boolean {
    const gl = this.canvas.getContext('webgl2', {
      alpha: false,
      premultipliedAlpha: false,
      antialias: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL2 unavailable');
    this.gl = gl;

    const program = linkProgram(gl, VERT_SRC, FRAG_SRC);
    this.program = program;

    const uniforms = {} as UniformMap;
    for (const name of UNIFORM_NAMES) {
      uniforms[name] = gl.getUniformLocation(program, name);
    }
    this.uniforms = uniforms;

    // 画像四隅の UV（トライアングルストリップ）。
    const quad = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
    const buffer = gl.createBuffer();
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.quadBuffer = buffer;
    this.vao = vao;

    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.clearColor(0, 0, 0, 1);

    // 既存 state からテクスチャを再構築（コンテキスト復旧時に必要）。
    this.imageTex = null;
    this.lutTex = null;
    this.uploadImageTexture();
    this.uploadLutTexture();
    return true;
  }

  private uploadImageTexture(): void {
    const gl = this.gl;
    if (!gl) return;
    const img = this.state.image;
    if (!img) return;
    if (!this.imageTex) this.imageTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.imageTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); // v=0 を画像上端に合わせる
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  private uploadLutTexture(): void {
    const gl = this.gl;
    if (!gl) return;
    const { lut, lutSize: n } = this.state;
    if (!lut || n <= 0) return;
    if (!this.lutTex) this.lutTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, this.lutTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); // LUT データは反転させない
    // RGB16F（コアでフィルタ可能・高精度）。LUT は RGB・R 最速なので再パック不要。
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, n, n, n, 0, gl.RGB, gl.FLOAT, lut);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
  }

  private renderWebGL(): void {
    const gl = this.gl;
    const program = this.program;
    const uniforms = this.uniforms;
    if (!gl || !program || !uniforms) return;

    gl.clear(gl.COLOR_BUFFER_BIT);
    const img = this.state.image;
    if (!img || !this.imageTex) return;

    const w = this.canvas.width;
    const h = this.canvas.height;
    const s = this.state;
    const lutOn = s.lutEnabled && this.lutTex != null && s.lut != null;
    const texel = lutHalfTexel(s.lutSize > 0 ? s.lutSize : 2);

    gl.useProgram(program);
    gl.bindVertexArray(this.vao);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.imageTex);
    gl.uniform1i(uniforms.u_image, 0);
    if (this.lutTex) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_3D, this.lutTex);
      gl.uniform1i(uniforms.u_lut, 1);
    }

    gl.uniform2f(uniforms.u_imageSize, img.width, img.height);
    gl.uniform1f(uniforms.u_scaleDev, s.scale * this.dpr);
    gl.uniform2f(uniforms.u_offsetDev, s.offsetX * this.dpr, s.offsetY * this.dpr);
    gl.uniform2f(uniforms.u_canvasSize, w, h);
    gl.uniform1f(uniforms.u_lutScale, texel.scale);
    gl.uniform1f(uniforms.u_lutOffset, texel.offset);
    gl.uniform1i(uniforms.u_lutEnabled, lutOn ? 1 : 0);
    gl.uniform1i(uniforms.u_viewMode, viewModeToInt(s.viewMode));
    gl.uniform1f(uniforms.u_split, s.split);
    gl.uniform1f(uniforms.u_canvasW, w);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  private destroyWebGL(): void {
    const gl = this.gl;
    if (!gl) return;
    if (this.imageTex) gl.deleteTexture(this.imageTex);
    if (this.lutTex) gl.deleteTexture(this.lutTex);
    if (this.quadBuffer) gl.deleteBuffer(this.quadBuffer);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.program) gl.deleteProgram(this.program);
    this.imageTex = null;
    this.lutTex = null;
    this.quadBuffer = null;
    this.vao = null;
    this.program = null;
    this.uniforms = null;
    this.gl = null;
  }

  // ================= Canvas 2D フォールバック =================

  private switchToCanvas2D(): void {
    if (this.backendKind === 'canvas2d') return;
    this.destroyWebGL();
    this.backendKind = 'canvas2d';
    const ctx = this.canvas.getContext('2d', { alpha: false });
    this.ctx2d = ctx;
    const src = document.createElement('canvas');
    const res = document.createElement('canvas');
    this.srcCanvas = src;
    this.resultCanvas = res;
    this.srcCtx = src.getContext('2d', { alpha: false });
    this.resultCtx = res.getContext('2d', { alpha: false });
    this.sourceDirty = true;
    this.resultDirty = true;
    for (const cb of this.backendCbs) cb('canvas2d');
    this.render('full');
  }

  private renderCanvas2D(quality: RenderQuality): void {
    const ctx = this.ctx2d;
    if (!ctx) return;
    const W = this.canvas.width;
    const H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);
    const img = this.state.image;
    if (!img) return;

    const longEdge = quality === 'draft' ? DRAFT_LONG_EDGE : FULL_LONG_EDGE;
    this.ensureSource(longEdge);
    this.ensureResult();
    this.composite(ctx, W, H);
  }

  /** 元画像を作業解像度で取得し ImageData をキャッシュする（変更時のみ再取得）。 */
  private ensureSource(longEdge: number): void {
    const img = this.state.image;
    const srcCanvas = this.srcCanvas;
    const srcCtx = this.srcCtx;
    if (!img || !srcCanvas || !srcCtx) return;
    if (!this.sourceDirty && this.cachedLongEdge === longEdge && this.srcImageData) return;

    const { w, h } = workingSize(img.width, img.height, longEdge);
    srcCanvas.width = w;
    srcCanvas.height = h;
    srcCtx.imageSmoothingEnabled = true;
    srcCtx.clearRect(0, 0, w, h);
    srcCtx.drawImage(img, 0, 0, w, h);
    this.srcImageData = srcCtx.getImageData(0, 0, w, h);
    this.workW = w;
    this.workH = h;
    this.cachedLongEdge = longEdge;
    this.sourceDirty = false;
    this.resultDirty = true; // 解像度が変わったので result も作り直す
  }

  /** LUT を CPU 適用した結果 ImageData を作る（LUT/enabled 変更時のみ再計算）。 */
  private ensureResult(): void {
    const srcData = this.srcImageData;
    const resCanvas = this.resultCanvas;
    const resCtx = this.resultCtx;
    if (!srcData || !resCanvas || !resCtx) return;
    if (!this.resultDirty && this.resultImageData) return;

    const w = this.workW;
    const h = this.workH;
    resCanvas.width = w;
    resCanvas.height = h;
    if (!this.resultImageData || this.resultImageData.width !== w || this.resultImageData.height !== h) {
      this.resultImageData = resCtx.createImageData(w, h);
    }
    const src = srcData.data;
    const dst = this.resultImageData.data;
    const s = this.state;
    const useLut = s.lutEnabled && s.lut != null && s.lutSize > 0;

    if (useLut) {
      const lut = s.lut as Float32Array;
      const n = s.lutSize;
      const out: Vec3 = [0, 0, 0];
      const inv255 = 1 / 255;
      for (let i = 0; i < src.length; i += 4) {
        trilinearSample(lut, n, src[i] * inv255, src[i + 1] * inv255, src[i + 2] * inv255, out);
        dst[i] = Math.round(out[0] * 255);
        dst[i + 1] = Math.round(out[1] * 255);
        dst[i + 2] = Math.round(out[2] * 255);
        dst[i + 3] = 255;
      }
    } else {
      // LUT 無効：元画像をそのままコピー。
      dst.set(src);
    }
    resCtx.putImageData(this.resultImageData, 0, 0);
    this.resultDirty = false;
  }

  /** 作業用キャンバスをビュー変換・split に従い本体キャンバスへ合成する。 */
  private composite(ctx: CanvasRenderingContext2D, W: number, H: number): void {
    const img = this.state.image;
    const src = this.srcCanvas;
    const res = this.resultCanvas;
    if (!img || !src || !res) return;
    const s = this.state;
    const dx = s.offsetX * this.dpr;
    const dy = s.offsetY * this.dpr;
    const dw = img.width * s.scale * this.dpr;
    const dh = img.height * s.scale * this.dpr;
    ctx.imageSmoothingEnabled = true;

    if (s.viewMode === 'original') {
      ctx.drawImage(src, dx, dy, dw, dh);
      return;
    }
    if (s.viewMode === 'result') {
      ctx.drawImage(res, dx, dy, dw, dh);
      return;
    }
    // compare：左=適用前 / 右=適用後。split はキャンバス幅に対する割合。
    const splitX = s.split * W;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, splitX, H);
    ctx.clip();
    ctx.drawImage(src, dx, dy, dw, dh);
    ctx.restore();
    ctx.save();
    ctx.beginPath();
    ctx.rect(splitX, 0, W - splitX, H);
    ctx.clip();
    ctx.drawImage(res, dx, dy, dw, dh);
    ctx.restore();
  }
}

// ---- シェーダーコンパイルユーティリティ ----

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('createShader failed');
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`shader compile error: ${log ?? 'unknown'}`);
  }
  return shader;
}

function linkProgram(gl: WebGL2RenderingContext, vertSrc: string, fragSrc: string): WebGLProgram {
  const vert = compileShader(gl, gl.VERTEX_SHADER, vertSrc);
  const frag = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
  const program = gl.createProgram();
  if (!program) throw new Error('createProgram failed');
  gl.attachShader(program, vert);
  gl.attachShader(program, frag);
  gl.linkProgram(program);
  // リンク後はシェーダーオブジェクトを解放してよい。
  gl.deleteShader(vert);
  gl.deleteShader(frag);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`program link error: ${log ?? 'unknown'}`);
  }
  return program;
}
