/**
 * 最小 ZIP ライター（Resonite `.resonitepackage` 組み立て用・純粋関数）。
 *
 * ローカルファイルヘッダー＋セントラルディレクトリ＋EOCD だけの素朴な実装。
 * 各エントリは `CompressionStream('deflate-raw')` が使える環境では DEFLATE
 * （method 8）、無い環境では STORE（method 0）で格納する。DEFLATE 結果が
 * 元より大きくなる場合は STORE を採用する。ZIP64 は使わない（合計 <4GB 前提）。
 *
 * 日時は再現性を優先して固定値（DOS date/time = 0）とする。
 */

/** CRC-32 テーブル（IEEE 多項式 0xEDB88320）。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** バイト列の CRC-32（符号なし 32bit）。 */
function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * 固定 DOS 日時（再現性優先）。時刻 = 00:00:00、日付 = 1980-01-01。
 * 日付を 0 にすると月 0・日 0 の「無効な DOS 日付」となり、.NET / SharpZipLib 等の
 * 一部 ZIP リーダーがタイムスタンプ解釈時に例外を投げうるため、有効な最小日付を使う。
 */
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1; // year=1980, month=1, day=1 → 0x21

/** ZIP エントリ 1 件。`name` は ZIP 内パス（`/` 区切り・ASCII 想定）。 */
export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

/** 複数の Uint8Array を連結する。 */
function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/**
 * `deflate-raw` で圧縮する。`CompressionStream` が無い環境では null を返す。
 * @param data 圧縮する生バイト列
 * @returns 圧縮結果、または非対応時に null
 */
async function deflateRaw(data: Uint8Array): Promise<Uint8Array | null> {
  const CS = (globalThis as { CompressionStream?: typeof CompressionStream }).CompressionStream;
  if (typeof CS !== 'function') return null;
  try {
    const cs = new CS('deflate-raw');
    // 読み出しを先に開始してバックプレッシャーによるデッドロックを避け、書き込みは
    // try 内で await する（void 発火だと write/close の reject が未捕捉になるため）。
    const reader = cs.readable.getReader();
    const chunks: Uint8Array[] = [];
    const readAll = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
    })();
    const writer = cs.writable.getWriter();
    // SharedArrayBuffer は不使用（§3）のため BufferSource へ narrow。
    await writer.write(data as Uint8Array<ArrayBuffer>);
    await writer.close();
    await readAll;
    return concatBytes(chunks);
  } catch {
    return null;
  }
}

/** UTF-8 エンコード済みバイト列。 */
function encodeUtf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** エントリ 1 件の圧縮結果とメタ情報。 */
interface PreparedEntry {
  nameBytes: Uint8Array;
  method: number; // 0 = STORE, 8 = DEFLATE
  crc: number;
  compressed: Uint8Array;
  uncompressedSize: number;
}

/**
 * ZIP アーカイブを組み立てる。
 * @param entries 格納するエントリ配列（順序は保持）
 * @returns ZIP バイト列
 */
export async function buildZip(entries: ZipEntry[]): Promise<Uint8Array> {
  // 各エントリを事前に圧縮（DEFLATE が STORE より大きければ STORE 採用）。
  const prepared: PreparedEntry[] = [];
  for (const entry of entries) {
    const uncompressed = entry.data;
    const crc = crc32(uncompressed);
    let method = 0;
    let compressed = uncompressed;
    const deflated = await deflateRaw(uncompressed);
    if (deflated !== null && deflated.length < uncompressed.length) {
      method = 8;
      compressed = deflated;
    }
    prepared.push({
      nameBytes: encodeUtf8(entry.name),
      method,
      crc,
      compressed,
      uncompressedSize: uncompressed.length,
    });
  }

  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0; // 現在のローカルヘッダー先頭オフセット

  for (const p of prepared) {
    // ---- ローカルファイルヘッダー（30 バイト固定部）----
    const local = new Uint8Array(30 + p.nameBytes.length);
    const ldv = new DataView(local.buffer);
    ldv.setUint32(0, 0x04034b50, true); // シグネチャ
    ldv.setUint16(4, 20, true); // 展開に必要なバージョン（2.0）
    ldv.setUint16(6, 0, true); // 汎用ビットフラグ
    ldv.setUint16(8, p.method, true); // 圧縮方式
    ldv.setUint16(10, DOS_TIME, true); // 更新時刻（固定）
    ldv.setUint16(12, DOS_DATE, true); // 更新日付（固定・有効値）
    ldv.setUint32(14, p.crc, true); // CRC-32
    ldv.setUint32(18, p.compressed.length, true); // 圧縮サイズ
    ldv.setUint32(22, p.uncompressedSize, true); // 無圧縮サイズ
    ldv.setUint16(26, p.nameBytes.length, true); // ファイル名長
    ldv.setUint16(28, 0, true); // 拡張フィールド長
    local.set(p.nameBytes, 30);
    localParts.push(local, p.compressed);

    // ---- セントラルディレクトリレコード（46 バイト固定部）----
    const central = new Uint8Array(46 + p.nameBytes.length);
    const cdv = new DataView(central.buffer);
    cdv.setUint32(0, 0x02014b50, true); // シグネチャ
    cdv.setUint16(4, 20, true); // 作成バージョン
    cdv.setUint16(6, 20, true); // 展開に必要なバージョン
    cdv.setUint16(8, 0, true); // 汎用ビットフラグ
    cdv.setUint16(10, p.method, true); // 圧縮方式
    cdv.setUint16(12, DOS_TIME, true); // 更新時刻
    cdv.setUint16(14, DOS_DATE, true); // 更新日付（有効値）
    cdv.setUint32(16, p.crc, true); // CRC-32
    cdv.setUint32(20, p.compressed.length, true); // 圧縮サイズ
    cdv.setUint32(24, p.uncompressedSize, true); // 無圧縮サイズ
    cdv.setUint16(28, p.nameBytes.length, true); // ファイル名長
    cdv.setUint16(30, 0, true); // 拡張フィールド長
    cdv.setUint16(32, 0, true); // コメント長
    cdv.setUint16(34, 0, true); // 開始ディスク番号
    cdv.setUint16(36, 0, true); // 内部属性
    cdv.setUint32(38, 0, true); // 外部属性
    cdv.setUint32(42, offset, true); // ローカルヘッダーオフセット
    central.set(p.nameBytes, 46);
    centralParts.push(central);

    offset += local.length + p.compressed.length;
  }

  const centralDir = concatBytes(centralParts);
  const localData = concatBytes(localParts);

  // ---- EOCD（22 バイト）----
  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true); // シグネチャ
  edv.setUint16(4, 0, true); // このディスク番号
  edv.setUint16(6, 0, true); // セントラルディレクトリ開始ディスク
  edv.setUint16(8, prepared.length, true); // このディスクのエントリ数
  edv.setUint16(10, prepared.length, true); // 総エントリ数
  edv.setUint32(12, centralDir.length, true); // セントラルディレクトリのサイズ
  edv.setUint32(16, localData.length, true); // セントラルディレクトリのオフセット
  edv.setUint16(20, 0, true); // コメント長

  return concatBytes([localData, centralDir, eocd]);
}
