import { describe, expect, it } from 'vitest';
import { srgbToLinear } from '../src/core/colorspace.ts';
import { buildHistMatch, applyHistMatch } from '../src/core/histmatch.ts';
import { applyLinearTransform, buildMkl } from '../src/core/mkl.ts';
import { computeColorStats, extractValidSamples } from '../src/core/stats.ts';
import { buildMatchTransform } from '../src/core/pipeline.ts';
import { generateLut } from '../src/core/lut.ts';
import { NEUTRAL_ADJUSTMENTS } from '../src/core/types.ts';
import type { GenerateLutOptions, Vec3 } from '../src/core/types.ts';
import { mulberry32 } from './helpers.ts';

// ============================================================
// spec §5.4 確定決定「複合パイプラインの中間段では 0–1 クランプしない。
// クランプは最終ステップ（generateLut の出力）のみ」の回帰ガード。
//
// 検知メカニズム：
//   複合モード C は HM → MKL → HM の 3 段。各段は本来クランプせず、範囲外
//   （<0 / >1）の中間値をそのまま次段へ渡す（HM は端点傾きで線形外挿）。
//   本テストは、公開プリミティブ（buildHistMatch / buildMkl / apply*）だけで
//   「中間クランプを一切行わない」参照実装を pipeline と同じ手順で組み立て、
//   pipeline.buildMatchTransform('C') の出力と厳密一致することを検証する。
//   もし pipeline の段間（mapSamples での統計推定、または apply クロージャの
//   段間受け渡し）に 0–1 クランプが混入すると、範囲外を経由する入力で参照実装と
//   出力が乖離し、このテストが落ちる。実装内部へフックは入れず、公開 API の
//   出力性質のみで検証している。
// ============================================================

const SAMPLE = { alphaThreshold: 0.5, blackThreshold: 0 };

/** 露出差の大きい暗い Source / 明るい Reference（中間段で範囲外値を必ず生む）。 */
function darkBrightPair(count: number): { src: Float32Array; ref: Float32Array } {
  const rngS = mulberry32(4001);
  const rngR = mulberry32(4002);
  const src = new Float32Array(count * 4);
  const ref = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    // Source: 暗部に圧縮（ガンマ 0.02〜0.38・チャンネル独立でフルランク）。
    src[i * 4] = srgbToLinear(0.02 + rngS() * 0.36);
    src[i * 4 + 1] = srgbToLinear(0.02 + rngS() * 0.36);
    src[i * 4 + 2] = srgbToLinear(0.02 + rngS() * 0.36);
    src[i * 4 + 3] = 1;
    // Reference: 明部（ガンマ 0.62〜0.98）。Source との大きなゲイン差を作る。
    ref[i * 4] = srgbToLinear(0.62 + rngR() * 0.36);
    ref[i * 4 + 1] = srgbToLinear(0.62 + rngR() * 0.36);
    ref[i * 4 + 2] = srgbToLinear(0.62 + rngR() * 0.36);
    ref[i * 4 + 3] = 1;
  }
  return { src, ref };
}

/** クランプを一切行わずサンプルを変換で押し出す（pipeline.mapSamples と同一手順）。 */
function mapNoClamp(
  samples: Float32Array,
  apply: (r: number, g: number, b: number, out: Vec3) => void,
): Float32Array {
  const out = new Float32Array(samples.length);
  const t: Vec3 = [0, 0, 0];
  for (let i = 0; i < samples.length; i += 3) {
    apply(samples[i], samples[i + 1], samples[i + 2], t);
    out[i] = t[0];
    out[i + 1] = t[1];
    out[i + 2] = t[2];
  }
  return out;
}

describe('中間段で 0–1 クランプしない（§5.4 複合モード C）', () => {
  it('公開プリミティブで組んだ「中間クランプなし」参照実装と厳密一致する', () => {
    const { src, ref } = darkBrightPair(4096);
    const srcSamples = extractValidSamples(src, 4, SAMPLE);
    const refSamples = extractValidSamples(ref, 4, SAMPLE);

    // --- 参照実装：pipeline.buildComposite と同じ手順・ただしクランプ皆無 ---
    const srcStats = computeColorStats(srcSamples);
    const refStats = computeColorStats(refSamples);
    const n = Math.min(srcStats.count, refStats.count);

    const hm1 = buildHistMatch(srcSamples, refSamples);
    const s1 = mapNoClamp(srcSamples, (r, g, b, o) => applyHistMatch(hm1, r, g, b, o));
    const s1Stats = computeColorStats(s1);
    const mkl = buildMkl(s1Stats, refStats, n);
    const s2 = mapNoClamp(s1, (r, g, b, o) => applyLinearTransform(mkl.transform, r, g, b, o));
    const hm2 = buildHistMatch(s2, refSamples);

    const refApply = (r: number, g: number, b: number, out: Vec3): void => {
      const t1: Vec3 = [0, 0, 0];
      const t2: Vec3 = [0, 0, 0];
      applyHistMatch(hm1, r, g, b, t1);
      applyLinearTransform(mkl.transform, t1[0], t1[1], t1[2], t2);
      applyHistMatch(hm2, t2[0], t2[1], t2[2], out);
    };

    // pipeline の実装（複合モード C）。
    const match = buildMatchTransform('C', srcSamples, refSamples);
    expect(match.fallback).toBe(false);

    // 入力群：格子相当の [0,1] リニア値に加え、明示的に範囲外（<0 / >1）を含める。
    // 範囲外入力は HM の線形外挿・MKL 範囲外出力を確実に経由させ、
    // 「中間段クランプ」誤実装があれば乖離を生む。
    const inputs: Vec3[] = [];
    for (let k = 0; k <= 10; k++) {
      const v = srgbToLinear(k / 10);
      inputs.push([v, v, v]);
    }
    inputs.push([-0.15, 0.5, 1.35]);
    inputs.push([1.4, -0.2, 0.8]);
    inputs.push([1.6, 1.6, 1.6]);
    inputs.push([-0.3, -0.3, -0.3]);

    // 非自明性の担保：参照実装の中間値（t1 or t2）が実際に [0,1] を外れることを確認。
    // これが成り立たなければテストは範囲外経路を検証できておらず無意味になる。
    let sawOutOfRange = false;
    const gotPipeline: Vec3 = [0, 0, 0];
    const gotRef: Vec3 = [0, 0, 0];
    for (const [r, g, b] of inputs) {
      // 中間値の範囲外検出（参照側の各段を辿る）。
      const t1: Vec3 = [0, 0, 0];
      const t2: Vec3 = [0, 0, 0];
      applyHistMatch(hm1, r, g, b, t1);
      applyLinearTransform(mkl.transform, t1[0], t1[1], t1[2], t2);
      for (const c of [...t1, ...t2]) {
        if (c < 0 || c > 1) sawOutOfRange = true;
      }

      match.apply(r, g, b, gotPipeline);
      refApply(r, g, b, gotRef);
      for (let c = 0; c < 3; c++) {
        // 同一の公開プリミティブを同順で呼ぶため、正しい（中間クランプなし）実装なら
        // ほぼビット一致する。段間クランプ混入時のみ乖離する。
        expect(Math.abs(gotPipeline[c] - gotRef[c])).toBeLessThan(1e-9);
      }
    }
    expect(sawOutOfRange).toBe(true);
  });

  it('露出差の大きいペアでも最終 LUT は範囲内・チャンネル単調性を保つ（回帰ネット）', () => {
    const { src, ref } = darkBrightPair(4096);
    const n = 17;
    const options: GenerateLutOptions = {
      mode: 'C',
      size: n,
      strength: 100,
      smoothing: 0,
      manual: { ...NEUTRAL_ADJUSTMENTS },
      sample: SAMPLE,
      // 減衰を実質無効化し、複合変換そのものの性質（範囲外経由後の単調性）を見る。
      d0: 1e9,
    };
    const { lut } = generateLut(src, ref, 4, options);

    // 最終クランプは効いている（出力は [0,1]）。
    for (let i = 0; i < lut.length; i++) {
      expect(lut[i]).toBeGreaterThanOrEqual(0);
      expect(lut[i]).toBeLessThanOrEqual(1);
    }

    // グレースケール対角に沿って各チャンネルが単調非減少（中間クランプで階段が
    // 崩れたり反転したりしないことのサニティネット）。
    const at = (i: number, c: number): number => {
      const idx = (i + i * n + i * n * n) * 3;
      return lut[idx + c];
    };
    for (let c = 0; c < 3; c++) {
      for (let i = 1; i < n; i++) {
        expect(at(i, c)).toBeGreaterThanOrEqual(at(i - 1, c) - 1e-6);
      }
    }
  });

  it('露出差の大きい複合ペアの LUT スナップショット（中間クランプ混入で変化）', () => {
    const { src, ref } = darkBrightPair(4096);
    const n = 17;
    const { lut, size } = generateLut(src, ref, 4, {
      mode: 'C',
      size: n,
      strength: 100,
      smoothing: 0,
      manual: { ...NEUTRAL_ADJUSTMENTS },
      sample: SAMPLE,
      d0: 1e9,
    });
    const round = (v: number): number => Math.round(v * 1e5) / 1e5;
    const samples: Record<string, number[]> = {};
    for (const [r, g, b] of [
      [0, 0, 0],
      [8, 8, 8],
      [16, 16, 16],
      [16, 0, 8],
      [2, 14, 6],
    ]) {
      const idx = (r + g * size + b * size * size) * 3;
      samples[`${r},${g},${b}`] = [round(lut[idx]), round(lut[idx + 1]), round(lut[idx + 2])];
    }
    expect(samples).toMatchSnapshot();
  });
});
