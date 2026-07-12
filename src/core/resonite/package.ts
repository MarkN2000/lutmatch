/**
 * Resonite `.resonitepackage`（内部 ZIP）の組み立て（純粋関数・fetch/DOM 非依存）。
 *
 * テンプレート差し替え方式：実機検証済みのテンプレートパッケージから、LUT アセット
 * （Bmp3D）とメインオブジェクト（FrDT）だけを現在の LUT に応じて作り直し、record の
 * 参照ハッシュを更新して再パッケージする。他のアセット（フォント・シェーダ等 8 件）と
 * メタデータ（.bitmap サムネイル）はテンプレートのまま流用する。
 *
 * 手順（spec §4.6 / §13）：
 *   1. LUT 格子 → encodeBmp3d で新 LUT アセット化し SHA-256 を計算
 *   2. FrDT 展開済みペイロード中の旧 LUT ハッシュ ASCII 文字列を新ハッシュへバイト置換
 *   3. パッチ済みを brotliStore で圧縮し 9 バイトの FrDT ヘッダーを付けて新 FrDT アセット化・SHA-256
 *   4. record JSON の assetUri（メイン FrDT 参照）・assetManifest（旧 LUT エントリ）・name を更新
 *   5. R-Main.record + Assets/（新 FrDT・新 LUT・テンプレ 8 件）+ Metadata/.bitmap を ZIP 化
 */

import { encodeBmp3d } from './bmp3d.ts';
import { brotliStore } from './brotliStore.ts';
import { buildZip, type ZipEntry } from './zip.ts';

/**
 * テンプレートの旧 LUT アセットの SHA-256（frdt-decoded.bin 内に ASCII で 1 箇所、
 * template.record の assetManifest に 1 エントリ）。差し替え時に検出・置換する。
 */
export const OLD_LUT_HASH =
  '5a885122a098257f8f694415aba49c0f07d627885830800a5c0f811253a431b0';

/**
 * テンプレートのメインオブジェクト（FrDT）アセットの SHA-256。
 * template.record の assetUri が `packdb:///<この値>` を指す（assetManifest には載らない）。
 */
export const OLD_FRDT_HASH =
  '1f4709c2508c450f07a4a5f6891d0ef421eb93fb54907bc642e94fbd1ab77bbe';

/** FrDT アセットの 9 バイトヘッダー："FrDT" + 0x00×4 + 0x03。 */
const FRDT_HEADER = new Uint8Array([0x46, 0x72, 0x44, 0x54, 0x00, 0x00, 0x00, 0x00, 0x03]);

/** buildResonitePackage の入力。 */
export interface ResonitePackageInput {
  /** LUT 格子（長さ N³×3・RGB・0..1・R 最速）。 */
  lut: Float32Array;
  /** 格子解像度 N。 */
  size: number;
  /** record の name とパッケージ内容に用いるベース名（拡張子なし）。 */
  name: string;
  /** テンプレート record（R-Main.record）の JSON 文字列。 */
  templateRecordJson: string;
  /** FrDT の展開済みペイロード（frdt-decoded.bin）。 */
  frdtDecoded: Uint8Array;
  /** 流用する 8 テンプレアセット（ファイル名＝SHA-256）。 */
  assets: Array<{ hash: string; data: Uint8Array }>;
  /** メタデータ .bitmap のファイル名（例 `<hash>.bitmap`）。 */
  metadataName: string;
  /** メタデータ .bitmap の中身。 */
  metadataData: Uint8Array;
}

/** バイト列を小文字 16 進文字列へ。 */
function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/** SHA-256（16 進小文字）。Node のテスト環境でも globalThis.crypto で動く。 */
async function sha256Hex(data: Uint8Array): Promise<string> {
  // SharedArrayBuffer は不使用（§3）のため BufferSource へ narrow。
  const digest = await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>);
  return toHex(new Uint8Array(digest));
}

/**
 * `haystack` 中の ASCII 部分列 `needle` を `replacement` へ置換する。
 * `needle` と `replacement` は同一長を要求し、出現回数が 1 でなければ throw する
 * （テンプレート破損検知）。
 */
function replaceAsciiOnce(
  haystack: Uint8Array,
  needle: string,
  replacement: string,
): Uint8Array {
  if (needle.length !== replacement.length) {
    throw new Error('replaceAsciiOnce: needle と replacement の長さが一致しない');
  }
  const needleBytes = new Uint8Array(needle.length);
  for (let i = 0; i < needle.length; i++) needleBytes[i] = needle.charCodeAt(i);

  const matches: number[] = [];
  const limit = haystack.length - needleBytes.length;
  outer: for (let i = 0; i <= limit; i++) {
    for (let j = 0; j < needleBytes.length; j++) {
      if (haystack[i + j] !== needleBytes[j]) continue outer;
    }
    matches.push(i);
  }
  if (matches.length !== 1) {
    throw new Error(
      `replaceAsciiOnce: 期待した出現回数は 1 だが ${matches.length} 件見つかった（テンプレート破損の可能性）`,
    );
  }

  const out = new Uint8Array(haystack);
  const at = matches[0];
  for (let j = 0; j < replacement.length; j++) out[at + j] = replacement.charCodeAt(j);
  return out;
}

/** record JSON の assetManifest エントリ（一部）。 */
interface ManifestEntry {
  hash: string;
  bytes: number;
}

/** record JSON の必要フィールドのみを型付け。 */
interface RecordJson {
  assetUri: string;
  name: string;
  assetManifest: ManifestEntry[];
  [key: string]: unknown;
}

/**
 * Resonite パッケージ（ZIP バイト列）を組み立てる。
 * @param input LUT・テンプレート資材一式
 * @returns `.resonitepackage` の中身（ZIP バイト列）
 */
export async function buildResonitePackage(input: ResonitePackageInput): Promise<Uint8Array> {
  // 1. 新 LUT アセット（Bmp3D）を生成し SHA-256 を計算。
  const lutAsset = encodeBmp3d(input.lut, input.size);
  const lutHash = await sha256Hex(lutAsset);

  // 2. FrDT ペイロード中の旧 LUT ハッシュを新ハッシュへ置換（同一長・出現 1 件を検証）。
  const patched = replaceAsciiOnce(input.frdtDecoded, OLD_LUT_HASH, lutHash);

  // 3. store-only Brotli で圧縮し 9 バイトヘッダーを付けて新 FrDT アセット化・SHA-256。
  const compressed = brotliStore(patched);
  const frdtAsset = new Uint8Array(FRDT_HEADER.length + compressed.length);
  frdtAsset.set(FRDT_HEADER, 0);
  frdtAsset.set(compressed, FRDT_HEADER.length);
  const frdtHash = await sha256Hex(frdtAsset);

  // 4. record JSON を更新（assetUri＝新 FrDT・manifest の旧 LUT エントリ・name）。
  const record = JSON.parse(input.templateRecordJson) as RecordJson;
  if (record.assetUri !== `packdb:///${OLD_FRDT_HASH}`) {
    throw new Error('buildResonitePackage: テンプレート record の assetUri が想定と異なる');
  }
  record.assetUri = `packdb:///${frdtHash}`;
  const lutEntry = record.assetManifest.find((e) => e.hash === OLD_LUT_HASH);
  if (!lutEntry) {
    throw new Error('buildResonitePackage: assetManifest に旧 LUT ハッシュが見つからない');
  }
  lutEntry.hash = lutHash;
  lutEntry.bytes = lutAsset.length;
  record.name = input.name;
  const recordJson = JSON.stringify(record);

  // 5. ZIP 組み立て（R-Main.record + Assets/ ×10 + Metadata/.bitmap）。
  const entries: ZipEntry[] = [
    { name: 'R-Main.record', data: new TextEncoder().encode(recordJson) },
    { name: `Assets/${frdtHash}`, data: frdtAsset },
    { name: `Assets/${lutHash}`, data: lutAsset },
  ];
  for (const asset of input.assets) {
    entries.push({ name: `Assets/${asset.hash}`, data: asset.data });
  }
  entries.push({ name: `Metadata/${input.metadataName}`, data: input.metadataData });

  return buildZip(entries);
}
