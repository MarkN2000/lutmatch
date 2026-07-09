// scripts/gen-samples.mjs
//
// デモ用サンプル画像ペア（Source / Reference）をプログラム生成するスクリプト。
// 外部依存ゼロ：PNG エンコードは node:zlib の deflate を使った最小実装のみで行う。
//
// 使い方: node scripts/gen-samples.mjs
// 出力  : public/sample-source.png / public/sample-reference.png

import { deflateSync, inflateSync } from "node:zlib";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "..", "public");

const WIDTH = 1024;
const HEIGHT = 640;

// ---------------------------------------------------------------------------
// 最小 PNG エンコーダ（8bit RGB, フィルタタイプ0固定）
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// CRC32 テーブル
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

/**
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} rgb  width*height*3 の RGB8 バッファ（行優先）
 * @returns {Buffer} PNG ファイル全体のバイト列
 */
function encodePNG(width, height, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB (truecolor)
  ihdr[10] = 0; // compression method
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace method

  // スキャンラインごとにフィルタタイプバイト(0=None)を先頭に付与
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const srcOffset = y * stride;
    const dstOffset = y * (stride + 1);
    raw[dstOffset] = 0; // filter type: None
    rgb.copy
      ? rgb.copy(raw, dstOffset + 1, srcOffset, srcOffset + stride)
      : raw.set(rgb.subarray(srcOffset, srcOffset + stride), dstOffset + 1);
  }

  const idatData = deflateSync(raw, { level: 9 });

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", idatData),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * 生成した PNG が正しくデコード可能か簡易検証する。
 * シグネチャ・IHDR・IDAT の整合性、および zlib インフレートの成否を確認する。
 */
function verifyPNG(buf, expectedWidth, expectedHeight) {
  const errors = [];

  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    errors.push("PNG シグネチャ不一致");
  }

  let offset = 8;
  let ihdr = null;
  const idatChunks = [];
  let sawIEND = false;

  while (offset < buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const data = buf.subarray(dataStart, dataStart + len);
    const crcStored = buf.readUInt32BE(dataStart + len);
    const crcComputed = crc32(Buffer.concat([Buffer.from(type, "ascii"), data]));
    if (crcStored !== crcComputed) {
      errors.push(`${type} チャンクの CRC 不一致`);
    }

    if (type === "IHDR") ihdr = data;
    if (type === "IDAT") idatChunks.push(data);
    if (type === "IEND") sawIEND = true;

    offset = dataStart + len + 4;
  }

  if (!ihdr) errors.push("IHDR チャンクが見つからない");
  if (idatChunks.length === 0) errors.push("IDAT チャンクが見つからない");
  if (!sawIEND) errors.push("IEND チャンクが見つからない");

  if (ihdr) {
    const w = ihdr.readUInt32BE(0);
    const h = ihdr.readUInt32BE(4);
    const bitDepth = ihdr[8];
    const colorType = ihdr[9];
    if (w !== expectedWidth || h !== expectedHeight) {
      errors.push(`IHDR の解像度が想定と不一致 (${w}x${h})`);
    }
    if (bitDepth !== 8 || colorType !== 2) {
      errors.push(`IHDR の bitDepth/colorType が想定と不一致 (${bitDepth}, ${colorType})`);
    }

    if (idatChunks.length > 0) {
      try {
        const raw = inflateSync(Buffer.concat(idatChunks));
        const expectedRawLen = (w * 3 + 1) * h;
        if (raw.length !== expectedRawLen) {
          errors.push(
            `インフレート後のサイズが想定と不一致 (got ${raw.length}, want ${expectedRawLen})`
          );
        }
      } catch (e) {
        errors.push(`zlib インフレートに失敗: ${e.message}`);
      }
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// 決定的な擬似乱数・ノイズユーティリティ
// ---------------------------------------------------------------------------

/** 整数ハッシュベースの決定的疑似乱数（[0,1)） */
function hash01(i, seed) {
  let h = Math.imul(i ^ seed, 2654435761);
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519);
  h ^= h >>> 13;
  h = Math.imul(h, 3266489917);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function hash01_2d(x, y, seed) {
  return hash01(Math.imul(x, 374761393) ^ Math.imul(y, 668265263), seed);
}

function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** 1次元パーリン風ノイズ（複数オクターブの合成値ノイズ）。戻り値は概ね [-1,1]。 */
function ridgeNoise(x, seed, gridSpacing, octaves = 3) {
  let value = 0;
  let amplitude = 1;
  let totalAmplitude = 0;
  let freq = 1 / gridSpacing;
  for (let o = 0; o < octaves; o++) {
    const gx = x * freq;
    const gi = Math.floor(gx);
    const frac = gx - gi;
    const a = hash01(gi, seed + o * 1013);
    const b = hash01(gi + 1, seed + o * 1013);
    const t = smoothstep(frac);
    const n = lerp(a, b, t) * 2 - 1;
    value += n * amplitude;
    totalAmplitude += amplitude;
    amplitude *= 0.5;
    freq *= 2.3;
  }
  return value / totalAmplitude;
}

/**
 * 異方性 2D 値ノイズ（水平方向に引き伸ばした雲のような帯を作るため、
 * x方向とy方向で異なる周波数を使う）。戻り値は概ね [-1,1]。
 */
function cloudNoise2D(x, y, seed, gridSpacingX, gridSpacingY, octaves = 3) {
  let value = 0;
  let amplitude = 1;
  let totalAmplitude = 0;
  let freqX = 1 / gridSpacingX;
  let freqY = 1 / gridSpacingY;
  for (let o = 0; o < octaves; o++) {
    const nx = x * freqX;
    const ny = y * freqY;
    const x0 = Math.floor(nx);
    const y0 = Math.floor(ny);
    const fx = smoothstep(nx - x0);
    const fy = smoothstep(ny - y0);
    const s = seed + o * 977;
    const h00 = hash01_2d(x0, y0, s);
    const h10 = hash01_2d(x0 + 1, y0, s);
    const h01 = hash01_2d(x0, y0 + 1, s);
    const h11 = hash01_2d(x0 + 1, y0 + 1, s);
    const top = lerp(h00, h10, fx);
    const bottom = lerp(h01, h11, fx);
    const n = lerp(top, bottom, fy) * 2 - 1;
    value += n * amplitude;
    totalAmplitude += amplitude;
    amplitude *= 0.5;
    freqX *= 2.15;
    freqY *= 2.15;
  }
  return value / totalAmplitude;
}

// ---------------------------------------------------------------------------
// 風景シーン生成
// ---------------------------------------------------------------------------

/**
 * @param {object} opts シーンのパラメータ（構図・太陽位置・山の形など）
 * @returns {Uint8ClampedArray} width*height*3 の RGB フロート(0-255)バッファ
 */
function renderScene(opts) {
  const {
    width,
    height,
    seed,
    sunX,
    sunY,
    sunRadius,
    sunColor,
    zenithColor,
    horizonColor,
    hazeColor,
    groundStartFrac,
    mountainLayers, // [{ baseFrac, amplitude, gridSpacing, color, seedOffset }]
    grainAmount,
  } = opts;

  const groundStartY = Math.floor(height * groundStartFrac);
  const out = new Float64Array(width * height * 3);

  // 山の稜線を x ごとに事前計算（層ごと）
  const ridgeYByLayer = mountainLayers.map((layer) => {
    const arr = new Float64Array(width);
    for (let x = 0; x < width; x++) {
      const n = ridgeNoise(x, seed + layer.seedOffset, layer.gridSpacing, 3);
      const baseY = height * layer.baseFrac;
      arr[x] = baseY + n * layer.amplitude;
    }
    return arr;
  });

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 3;
      let r, g, b;

      if (y >= groundStartY) {
        // --- 地面／水面 ---
        const t = (y - groundStartY) / (height - groundStartY);
        const groundNear = opts.groundNearColor;
        const groundFar = opts.groundFarColor;
        let gr = lerp(groundFar[0], groundNear[0], t);
        let gg = lerp(groundFar[1], groundNear[1], t);
        let gb = lerp(groundFar[2], groundNear[2], t);

        // 空の反射（水面/湖を意識した弱いブレンド。下に行くほど反射は弱まる）
        const reflectY = clamp01(groundStartY - (y - groundStartY) * 0.4);
        const reflectT = Math.pow(clamp01(reflectY / Math.max(1, groundStartY)), 0.85);
        let rr = lerp(zenithColor[0], horizonColor[0], reflectT);
        let rg = lerp(zenithColor[1], horizonColor[1], reflectT);
        let rb = lerp(zenithColor[2], horizonColor[2], reflectT);
        const reflectStrength = 0.32 * (1 - t) * 0.9;
        gr = lerp(gr, rr, reflectStrength);
        gg = lerp(gg, rg, reflectStrength);
        gb = lerp(gb, rb, reflectStrength);

        // ゆるやかな縞ノイズ（草地/水面のテクスチャ感）
        const stripeN = ridgeNoise(x * 0.7 + y * 0.15, seed + 4242, 24, 2);
        const stripeAmt = 6 * (1 - t * 0.4);
        gr += stripeN * stripeAmt;
        gg += stripeN * stripeAmt * 0.8;
        gb += stripeN * stripeAmt * 0.6;

        r = gr;
        g = gg;
        b = gb;
      } else {
        // --- 空（ベース） ---
        const t = y / groundStartY;
        // 天頂→地平線のグラデーション、地平線付近はヘイズ色にブレンド
        const skyT = Math.pow(t, 0.85);
        let sr = lerp(zenithColor[0], horizonColor[0], skyT);
        let sg = lerp(zenithColor[1], horizonColor[1], skyT);
        let sb = lerp(zenithColor[2], horizonColor[2], skyT);

        const hazeT = clamp01((t - 0.6) / 0.4);
        sr = lerp(sr, hazeColor[0], hazeT * 0.6);
        sg = lerp(sg, hazeColor[1], hazeT * 0.6);
        sb = lerp(sb, hazeColor[2], hazeT * 0.6);

        // 雲（水平に引き伸ばした2Dノイズを白側にブレンド。中間高度で最も出やすい）
        const cloudN = cloudNoise2D(x, y, seed + 777, 260, 70, 3);
        const cloudBand = Math.sin(t * Math.PI) ** 0.6;
        const cloudMask = clamp01((cloudN - 0.18) * 1.6) * cloudBand * 0.35;
        sr = lerp(sr, 250, cloudMask);
        sg = lerp(sg, 250, cloudMask);
        sb = lerp(sb, 248, cloudMask);

        // 太陽（コアの円盤＋ガウス風グロー）
        const dx = x - sunX;
        const dy = y - sunY;
        const dist2 = dx * dx + dy * dy;
        const core = dist2 < sunRadius * sunRadius ? 1 : 0;
        const glow = Math.exp(-dist2 / (2 * (sunRadius * 3.2) ** 2));
        const sunMix = clamp01(core * 0.95 + glow * 0.55);
        sr = lerp(sr, sunColor[0], sunMix);
        sg = lerp(sg, sunColor[1], sunMix);
        sb = lerp(sb, sunColor[2], sunMix);

        // --- 山（遠い層→近い層の順に合成。境界は数px幅でアンチエイリアス） ---
        let mr = sr,
          mg = sg,
          mb = sb;
        const edge = 1.3;
        for (let li = 0; li < mountainLayers.length; li++) {
          const ridgeY = ridgeYByLayer[li][x];
          const coverage = clamp01((y - (ridgeY - edge)) / (edge * 2));
          if (coverage > 0) {
            const layer = mountainLayers[li];
            mr = lerp(mr, layer.color[0], coverage);
            mg = lerp(mg, layer.color[1], coverage);
            mb = lerp(mb, layer.color[2], coverage);
          }
        }

        r = mr;
        g = mg;
        b = mb;
      }

      // 粒状ノイズ（決定的な擬似乱数、シード固定）
      // 実写のフィルム/センサーノイズは輝度相関が支配的なため、画素ごとに
      // 単一の乱数オフセット n を生成し R/G/B 全チャンネルへ同一に加える
      // （チャンネル独立ノイズは持たない＝完全に無彩色のノイズ）。
      // さらに振幅を輝度に応じてスケーリングし、シャドウでは控えめにする。
      // HM は R/G/B を独立に単調写像するため、暗部で明部と同じ振幅の
      // ノイズを入れると、写像後にチャンネル間で振幅・符号がずれてしまい、
      // マゼンタ/緑がかった非相関スペックルとして目立ってしまうため。
      if (grainAmount > 0) {
        const lum01 = clamp01((0.299 * r + 0.587 * g + 0.114 * b) / 255);
        // シャドウで振幅 15%、ハイライトでフル振幅になるようガンマ的に補間
        const ampScale = 0.15 + 0.85 * Math.pow(lum01, 0.7);
        const n = (hash01_2d(x, y, seed + 9001) - 0.5) * 2 * grainAmount * ampScale;
        r += n;
        g += n;
        b += n;
      }

      out[idx] = r;
      out[idx + 1] = g;
      out[idx + 2] = b;
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// フィルム調グレーディング（Reference 用の後処理）
// ---------------------------------------------------------------------------

/**
 * @param {Float64Array} scene width*height*3, 0-255 レンジの浮動小数
 */
function applyFilmGrade(scene, width, height) {
  const out = new Float64Array(scene.length);

  const lift = 0.06; // 黒浮き量 (0-1)
  const liftColor = [0.09, 0.10, 0.12]; // わずかに寒色寄りのリフト色
  const satKeep = 0.68; // 彩度の残存率
  const contrast = 0.88; // コントラスト係数（1未満で軟調化 = フェード）

  for (let i = 0; i < scene.length; i += 3) {
    let r = clamp01(scene[i] / 255);
    let g = clamp01(scene[i + 1] / 255);
    let b = clamp01(scene[i + 2] / 255);

    const lum = 0.299 * r + 0.587 * g + 0.114 * b;

    // 1. リフト（黒浮き）
    r = r + lift * (1 - r) * liftColor[0] * (1 / 0.1);
    g = g + lift * (1 - g) * liftColor[1] * (1 / 0.1);
    b = b + lift * (1 - b) * liftColor[2] * (1 / 0.1);

    // 2. シャドウ=ティール、ハイライト=暖色 のカラーバランス
    const shadowMask = clamp01(1 - lum * 2.1);
    const highlightMask = clamp01((lum - 0.45) * 1.8);
    r += shadowMask * -0.025 + highlightMask * 0.05;
    g += shadowMask * 0.005 + highlightMask * 0.018;
    b += shadowMask * 0.045 - highlightMask * 0.03;

    // 3. 彩度控えめ
    const lum2 = 0.299 * r + 0.587 * g + 0.114 * b;
    r = lerp(lum2, r, satKeep);
    g = lerp(lum2, g, satKeep);
    b = lerp(lum2, b, satKeep);

    // 4. わずかなフェード（コントラスト低下）
    r = 0.5 + (r - 0.5) * contrast;
    g = 0.5 + (g - 0.5) * contrast;
    b = 0.5 + (b - 0.5) * contrast;

    out[i] = clamp01(r) * 255;
    out[i + 1] = clamp01(g) * 255;
    out[i + 2] = clamp01(b) * 255;
  }

  return out;
}

function toUint8(scene) {
  const buf = Buffer.alloc(scene.length);
  for (let i = 0; i < scene.length; i++) {
    const v = Math.round(scene[i]);
    buf[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Source / Reference のシーン定義
// ---------------------------------------------------------------------------

const sourceScene = renderScene({
  width: WIDTH,
  height: HEIGHT,
  seed: 1234,
  sunX: WIDTH * 0.74,
  sunY: HEIGHT * 0.22,
  sunRadius: 34,
  sunColor: [255, 248, 224],
  zenithColor: [70, 130, 200],
  horizonColor: [200, 216, 222],
  hazeColor: [222, 214, 200],
  groundStartFrac: 0.6,
  mountainLayers: [
    {
      baseFrac: 0.46,
      amplitude: 34,
      gridSpacing: 220,
      color: [150, 165, 178],
      seedOffset: 11,
    },
    {
      baseFrac: 0.5,
      amplitude: 46,
      gridSpacing: 160,
      color: [104, 124, 120],
      seedOffset: 57,
    },
    {
      baseFrac: 0.56,
      amplitude: 40,
      gridSpacing: 110,
      color: [66, 92, 74],
      seedOffset: 91,
    },
  ],
  groundNearColor: [70, 96, 58],
  groundFarColor: [120, 138, 120],
  grainAmount: 3.2,
});

const referenceScene = renderScene({
  width: WIDTH,
  height: HEIGHT,
  seed: 5678, // 別シード → 山の形・粒状ノイズが変化
  sunX: WIDTH * 0.28, // 太陽位置を変えて構図を変化
  sunY: HEIGHT * 0.16,
  sunRadius: 30,
  sunColor: [255, 244, 210],
  zenithColor: [76, 128, 196],
  horizonColor: [208, 214, 214],
  hazeColor: [226, 210, 190],
  groundStartFrac: 0.56, // 地平線位置を変えて構図を変化
  mountainLayers: [
    {
      baseFrac: 0.42,
      amplitude: 44,
      gridSpacing: 240,
      color: [146, 158, 172],
      seedOffset: 23,
    },
    {
      baseFrac: 0.47,
      amplitude: 38,
      gridSpacing: 150,
      color: [98, 116, 112],
      seedOffset: 68,
    },
    {
      baseFrac: 0.52,
      amplitude: 50,
      gridSpacing: 95,
      color: [58, 82, 66],
      seedOffset: 104,
    },
  ],
  groundNearColor: [78, 100, 62],
  groundFarColor: [126, 140, 122],
  grainAmount: 3.2,
});

const referenceGraded = applyFilmGrade(referenceScene, WIDTH, HEIGHT);

// ---------------------------------------------------------------------------
// 書き出し
// ---------------------------------------------------------------------------

mkdirSync(OUT_DIR, { recursive: true });

const sourcePath = join(OUT_DIR, "sample-source.png");
const referencePath = join(OUT_DIR, "sample-reference.png");

const sourcePNG = encodePNG(WIDTH, HEIGHT, toUint8(sourceScene));
const referencePNG = encodePNG(WIDTH, HEIGHT, toUint8(referenceGraded));

writeFileSync(sourcePath, sourcePNG);
writeFileSync(referencePath, referencePNG);

// ---------------------------------------------------------------------------
// 検証
// ---------------------------------------------------------------------------

let ok = true;
for (const [label, path] of [
  ["sample-source.png", sourcePath],
  ["sample-reference.png", referencePath],
]) {
  const buf = readFileSync(path);
  const errors = verifyPNG(buf, WIDTH, HEIGHT);
  const sizeKB = (buf.length / 1024).toFixed(1);
  if (errors.length === 0) {
    console.log(`OK   ${label}: ${sizeKB} KB, ${WIDTH}x${HEIGHT} — デコード検証成功`);
  } else {
    ok = false;
    console.log(`NG   ${label}: ${sizeKB} KB — 検証エラー:`);
    for (const e of errors) console.log(`       - ${e}`);
  }
  if (buf.length > 1024 * 1024) {
    ok = false;
    console.log(`NG   ${label}: ファイルサイズが1MBを超えています (${sizeKB} KB)`);
  }
}

if (!ok) {
  process.exitCode = 1;
}
