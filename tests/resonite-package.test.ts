import { readFileSync } from 'node:fs';
import { brotliDecompressSync, inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  buildResonitePackage,
  OLD_FRDT_HASH,
  OLD_LUT_HASH,
} from '../src/core/resonite/package.ts';
import { floatToHalf } from '../src/core/resonite/bmp3d.ts';
import { lzmaDecodeAlone, parseZip, type ParsedZipEntry } from './resonite-helpers.ts';

const TEMPLATE_DIR = new URL('../public/resonite-template/', import.meta.url);
const METADATA_NAME =
  'a36499239050e1cf138b00b1fac4ef15b1b567d43e01e0c8cf4dcfbce22681f7.bitmap';

/** テンプレート資材をバイト列で読む。 */
function readBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(name, TEMPLATE_DIR)));
}

/** SHA-256（16 進小文字）。 */
async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>);
  let s = '';
  for (const b of new Uint8Array(digest)) s += b.toString(16).padStart(2, '0');
  return s;
}

/** ASCII 部分列の出現回数。 */
function countAscii(haystack: Uint8Array, needle: string): number {
  const nb = new Uint8Array(needle.length);
  for (let i = 0; i < needle.length; i++) nb[i] = needle.charCodeAt(i);
  let count = 0;
  outer: for (let i = 0; i <= haystack.length - nb.length; i++) {
    for (let j = 0; j < nb.length; j++) if (haystack[i + j] !== nb[j]) continue outer;
    count++;
  }
  return count;
}

/** テスト用の勾配 LUT（x=R 最速・各チャンネル異なる係数）。 */
function makeLut(n: number): Float32Array {
  const lut = new Float32Array(n * n * n * 3);
  const d = n - 1;
  let i = 0;
  for (let z = 0; z < n; z++) {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        lut[i++] = x / d;
        lut[i++] = (y / d) * 0.7;
        lut[i++] = (z / d) * 0.45;
      }
    }
  }
  return lut;
}

/** テンプレート資材一式を組み立てる（loadResoniteTemplate 相当）。 */
function loadTemplate(): {
  templateRecordJson: string;
  frdtDecoded: Uint8Array;
  assets: Array<{ hash: string; data: Uint8Array }>;
  metadataName: string;
  metadataData: Uint8Array;
} {
  const templateRecordJson = new TextDecoder().decode(readBytes('template.record'));
  const manifest = (JSON.parse(templateRecordJson) as { assetManifest: Array<{ hash: string }> })
    .assetManifest;
  const assetHashes = manifest.map((e) => e.hash).filter((h) => h !== OLD_LUT_HASH);
  const assets = assetHashes.map((hash) => ({ hash, data: readBytes(`assets/${hash}`) }));
  return {
    templateRecordJson,
    frdtDecoded: readBytes('frdt-decoded.bin'),
    assets,
    metadataName: METADATA_NAME,
    metadataData: readBytes(`metadata/${METADATA_NAME}`),
  };
}

/** Bmp3D アセットを LZMA デコードして RGBAHalf ボクセル DataView を返す。 */
function decodeBmp3d(asset: Uint8Array): DataView {
  const dv = new DataView(asset.buffer, asset.byteOffset, asset.byteLength);
  const props = asset.subarray(37, 42);
  const uSize = Number(dv.getBigUint64(42, true));
  const stream = asset.subarray(58);
  const raw = lzmaDecodeAlone(props, uSize, stream);
  return new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
}

const parse = (zip: Uint8Array): ParsedZipEntry[] => parseZip(zip, inflateRawSync);

describe.each([17, 33])('buildResonitePackage（N=%i）', (n) => {
  it('テンプレート差し替えパッケージが全整合を満たす', async () => {
    const tpl = loadTemplate();
    const lut = makeLut(n);
    const baseName = 'my_look';
    const zip = await buildResonitePackage({
      lut,
      size: n,
      name: baseName,
      ...tpl,
    });
    const entries = parse(zip);
    const byName = new Map(entries.map((e) => [e.name, e.data]));

    // (a) エントリ構成 12 件（record 1 + Assets 10 + Metadata 1）。
    expect(entries.length).toBe(12);
    const assetEntries = entries.filter((e) => e.name.startsWith('Assets/'));
    expect(assetEntries.length).toBe(10);
    expect(byName.has('R-Main.record')).toBe(true);
    expect(byName.has(`Metadata/${METADATA_NAME}`)).toBe(true);

    // (b) 全 Assets のファイル名＝内容 SHA-256。
    for (const e of assetEntries) {
      const hash = e.name.slice('Assets/'.length);
      expect(await sha256Hex(e.data)).toBe(hash);
    }

    // record を解析。
    const record = JSON.parse(new TextDecoder().decode(byName.get('R-Main.record')!)) as {
      assetUri: string;
      name: string;
      assetManifest: Array<{ hash: string; bytes: number }>;
    };
    const frdtHash = record.assetUri.replace('packdb:///', '');
    // LUT アセット＝新規 2 件（FrDT・LUT）のうち FrDT でない方。
    const templateHashes = new Set(tpl.assets.map((a) => a.hash));
    const lutName = assetEntries
      .map((e) => e.name)
      .find((name) => name !== `Assets/${frdtHash}` && !templateHashes.has(name.slice('Assets/'.length)));
    expect(lutName).toBeDefined();
    const lutHash = lutName!.slice('Assets/'.length);
    const lutAssetData = byName.get(lutName!)!;

    // (c) assetUri/manifest 整合（bytes 含む）・旧ハッシュ消滅。
    const manifestLut = record.assetManifest.find((m) => m.hash === lutHash);
    expect(manifestLut).toBeDefined();
    expect(manifestLut!.bytes).toBe(lutAssetData.length);
    expect(record.assetUri).toBe(`packdb:///${frdtHash}`);
    expect(record.assetManifest.some((m) => m.hash === OLD_LUT_HASH)).toBe(false);
    expect(frdtHash).not.toBe(OLD_FRDT_HASH);
    expect(byName.has(`Assets/${frdtHash}`)).toBe(true);

    // (d) FrDT を brotliDecompress → 旧ハッシュ 0 件・新ハッシュ 1 件。
    const frdtAsset = byName.get(`Assets/${frdtHash}`)!;
    // 先頭 9 バイトは "FrDT" + 0x00×4 + 0x03。
    expect([...frdtAsset.subarray(0, 9)]).toEqual([0x46, 0x72, 0x44, 0x54, 0, 0, 0, 0, 3]);
    const decoded = brotliDecompressSync(frdtAsset.subarray(9));
    expect(countAscii(decoded, OLD_LUT_HASH)).toBe(0);
    expect(countAscii(decoded, lutHash)).toBe(1);

    // (e) Bmp3D を LZMA デコードして入力 LUT と float16 精度で一致。
    const view = decodeBmp3d(lutAssetData);
    for (let i = 0; i < n * n * n; i++) {
      const off = i * 8;
      expect(view.getUint16(off, true)).toBe(floatToHalf(lut[i * 3]));
      expect(view.getUint16(off + 2, true)).toBe(floatToHalf(lut[i * 3 + 1]));
      expect(view.getUint16(off + 4, true)).toBe(floatToHalf(lut[i * 3 + 2]));
      expect(view.getUint16(off + 6, true)).toBe(0x3c00); // A = 1.0
    }

    // (f) record name がベース名。
    expect(record.name).toBe(baseName);
  });
});

describe('buildResonitePackage の破損検知', () => {
  it('FrDT に旧 LUT ハッシュが無ければ throw', async () => {
    const tpl = loadTemplate();
    await expect(
      buildResonitePackage({
        lut: makeLut(9),
        size: 9,
        name: 'x',
        ...tpl,
        frdtDecoded: new TextEncoder().encode('no hash here'),
      }),
    ).rejects.toThrow();
  });
});
