/**
 * `.cube`（3D LUT）シリアライズ（§5.6）。
 *
 * - 改行は LF（`\n`）固定
 * - 数値は `toFixed(6)`（指数表記を排除）
 * - TITLE はサニタイズ（`"` と `\` を除去、印字可能 ASCII 以外は `_`）
 * - 大サイズでも配列 push → `join('\n')` で連結
 */

/** TITLE が空になった場合の既定名（印字可能 ASCII）。 */
export const DEFAULT_TITLE = 'LUT Match';

/**
 * TITLE 文字列を `.cube` 互換にサニタイズする（§5.6）。
 * ダブルクォート・バックスラッシュを除去し、印字可能 ASCII（0x20–0x7E）以外は `_` に置換。
 * 結果が空なら既定名を返す。
 * @param title ユーザー指定名
 */
export function sanitizeTitle(title: string): string {
  let out = '';
  for (const ch of title) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '"' || ch === '\\') continue; // 除去
    if (code >= 0x20 && code <= 0x7e) out += ch;
    else out += '_'; // 印字可能 ASCII 以外は置換
  }
  out = out.trim();
  return out.length > 0 ? out : DEFAULT_TITLE;
}

/**
 * LUT データを `.cube` テキストへシリアライズする（§5.6）。
 * @param lut LUT データ（長さ size³×3・R が最速で回る順序・[0,1] ガンマ RGB）
 * @param size 格子解像度 N
 * @param title TITLE に埋め込む名前（サニタイズされる）
 * @returns `.cube` ファイル内容（LF 区切り）
 */
export function serializeCube(lut: Float32Array, size: number, title: string): string {
  const expected = size * size * size * 3;
  if (lut.length !== expected) {
    throw new Error(`LUT length ${lut.length} does not match size ${size} (expected ${expected})`);
  }
  const lines: string[] = [];
  lines.push(`TITLE "${sanitizeTitle(title)}"`);
  lines.push(`LUT_3D_SIZE ${size}`);
  lines.push('DOMAIN_MIN 0.0 0.0 0.0');
  lines.push('DOMAIN_MAX 1.0 1.0 1.0');
  for (let i = 0; i < lut.length; i += 3) {
    lines.push(`${lut[i].toFixed(6)} ${lut[i + 1].toFixed(6)} ${lut[i + 2].toFixed(6)}`);
  }
  return lines.join('\n');
}
