/**
 * RGB カーブエディタの「ユーザー編集残差」を表す純粋関数モジュール（UI/DOM 非依存）。
 *
 * ユーザーがカーブエディタで置いたコントロールポイントは、基底カーブ（自動マッチ結果や
 * 恒等）からの**出力オフセット（残差 dy）**として表現する。残差を x で評価するときは
 * x 昇順の **monotone-cubic Hermite（Fritsch–Carlson 接線）**で補間し、区間内でデータ点を
 * 超えるオーバーシュートを起こさない。最外点の外側は端点 dy の定数保持とする。
 *
 * 【設計意図】残差ゼロ（＝編集なし）のときは補間結果が厳密に 0.0 になるよう実装し、
 * 「編集なし」を LUT 生成のゴールデンとビット一致で通せるようにする（isEmptyEdits 参照）。
 */

/** カーブ編集のコントロールポイント。x∈[0,1]（ガンマ空間の入力座標）、dy は基底カーブからの出力オフセット。 */
export interface ControlPoint {
  x: number;
  dy: number;
}

/**
 * カーブ編集一式。
 *
 * - `master`/`r`/`g`/`b`：RGB 残差カーブ。master はガンマ空間 Rec.709 luma を入力軸とし
 *   全チャンネルへ同量加算される（§5.7）。
 * - `hue`/`hueSat`（オプショナル・後方互換）：**周期軸**（色相 h∈[0,1) turns）の残差カーブ。
 *   `hue` は色相回転（dy∈[-1,1] → Δh = dy×HUE_CURVE_MAX_ROTATION_DEG）、`hueSat` は彩度ゲイン
 *   （dy∈[-1,1] → C' = C×(1+dy·w)）を表す。いずれも Lab の LCh 上で評価し L* は不変（§色相カーブ）。
 */
export interface CurveEdits {
  master: ControlPoint[];
  r: ControlPoint[];
  g: ControlPoint[];
  b: ControlPoint[];
  /** Hue vs Hue：色相回転カーブ（周期軸・オプショナル）。 */
  hue?: ControlPoint[];
  /** Hue vs Sat：彩度ゲインカーブ（周期軸・オプショナル）。 */
  hueSat?: ControlPoint[];
}

/** 1 チャンネルのコントロールポイント上限（端点 2 を含む）。 */
export const MAX_CONTROL_POINTS = 16;

/** 隣接点の最小 x 間隔（退化防止・UI 側でクランプに使用）。 */
export const CURVE_MIN_X_GAP = 0.01;

/** 同一 x とみなす許容差（重複点の統合に使う）。 */
const X_EPSILON = 1e-9;

/**
 * 入力点を防御的に整える：x 昇順ソートしたコピーを作り、x が同一（差 < X_EPSILON）の
 * 重複点は**後勝ち**（入力順で後ろの点）で 1 点に統合する。呼び出し側はソート済みや
 * 重複なしを保証しなくてよい。
 */
function cleanPoints(points: readonly ControlPoint[]): ControlPoint[] {
  // Array.sort は安定ソートなので、x が等しい点は入力順を保つ。
  const sorted = points.map((p) => ({ x: p.x, dy: p.dy })).sort((a, b) => a.x - b.x);
  const out: ControlPoint[] = [];
  for (const p of sorted) {
    if (out.length > 0 && Math.abs(p.x - out[out.length - 1].x) < X_EPSILON) {
      out[out.length - 1] = p; // 後勝ちで上書き。
    } else {
      out.push(p);
    }
  }
  return out;
}

/**
 * Fritsch–Carlson 法で各ノードの接線 m を計算する（前提：xs は狭義単調増加・長さ k≥2）。
 *
 * 各区間の割線傾き δ_i から接線を作る古典的アルゴリズム。隣接割線の符号が異なる
 * （または一方が 0 の）内部点では m=0（局所極値）とし、同符号では割線の平均を初期接線に
 * 取ったうえで α²+β²≤9 の単調性領域へ制限する。これにより区間ごとに単調＝オーバーシュートなし。
 *
 * 全ノード値が 0 のときは全接線が厳密に 0 になる（後段 Hermite が厳密に 0 を返す）。
 */
function computeTangents(xs: readonly number[], ys: readonly number[]): number[] {
  const k = xs.length;
  const delta = new Array<number>(k - 1);
  for (let i = 0; i < k - 1; i++) {
    delta[i] = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]);
  }

  // 初期接線：端点は片側割線、内部点は割線の符号で分岐。
  const m = new Array<number>(k);
  m[0] = delta[0];
  m[k - 1] = delta[k - 2];
  for (let i = 1; i < k - 1; i++) {
    if (delta[i - 1] * delta[i] <= 0) {
      m[i] = 0; // 符号反転またはいずれか 0 → 局所極値。
    } else {
      m[i] = (delta[i - 1] + delta[i]) / 2;
    }
  }

  // Fritsch–Carlson の単調性制限：区間ごとに (α,β)=(m_i,m_{i+1})/δ_i を半径 3 の円内へ収める。
  for (let i = 0; i < k - 1; i++) {
    if (delta[i] === 0) {
      // 平坦区間は両端接線を 0 に（両ノード値が等しい → 定数区間）。
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / delta[i];
    const b = m[i + 1] / delta[i];
    const s = a * a + b * b;
    if (s > 9) {
      const tau = 3 / Math.sqrt(s);
      m[i] = tau * a * delta[i];
      m[i + 1] = tau * b * delta[i];
    }
  }
  return m;
}

/**
 * 単一区間の三次 Hermite 補間カーネル（非周期・周期版で共有＝DRY）。
 * 端点値 y0,y1・端点接線 m0,m1・区間幅 h・区間内パラメータ t∈[0,1]。
 * 全 y・m が 0 のとき厳密に 0 を返す（残差ゼロの同一性保持）。
 */
function hermite(
  y0: number,
  y1: number,
  m0: number,
  m1: number,
  h: number,
  t: number,
): number {
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  return h00 * y0 + h10 * h * m0 + h01 * y1 + h11 * h * m1;
}

/**
 * 準備済みノード（xs, ys, ms）から x での Hermite 補間値を返す。
 * 最外点の外側は端点 dy の定数保持（x を [xs[0], xs[k−1]] にクランプ）。
 * 2 点（接線＝割線）のときは厳密に線形補間へ帰着する。
 */
function evalHermite(
  xs: readonly number[],
  ys: readonly number[],
  ms: readonly number[],
  x: number,
): number {
  const k = xs.length;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[k - 1]) return ys[k - 1];

  // x を含む区間 [xs[i], xs[i+1]] を線形走査で探す（点数 ≤16 なので十分）。
  let i = 0;
  while (i < k - 2 && x > xs[i + 1]) i++;

  const h = xs[i + 1] - xs[i];
  const t = (x - xs[i]) / h;
  return hermite(ys[i], ys[i + 1], ms[i], ms[i + 1], h, t);
}

/**
 * 残差を x で評価。点 0 個 → 0。点 1 個 → その dy を全域定数。
 * 複数点 → x 昇順の monotone-cubic Hermite（Fritsch–Carlson）でオーバーシュートなく補間。
 * 最外点の外側は端点 dy の定数保持。
 */
export function evalResidual(points: readonly ControlPoint[], x: number): number {
  const pts = cleanPoints(points);
  if (pts.length === 0) return 0;
  if (pts.length === 1) return pts[0].dy;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.dy);
  const ms = computeTangents(xs, ys);
  return evalHermite(xs, ys, ms, x);
}

/**
 * 格子解像度 n（LUT の N や描画解像度）に対し delta[i] = evalResidual(points, i/(n−1)) を返す。
 * 接線計算は 1 度だけ行い n 回評価する（evalResidual を n 回呼ぶより効率的・結果は等価）。
 */
export function sampleResidualToGrid(points: readonly ControlPoint[], n: number): Float32Array {
  const out = new Float32Array(n);
  const pts = cleanPoints(points);
  if (pts.length === 0) return out; // 全要素 0。
  if (pts.length === 1) {
    out.fill(pts[0].dy);
    return out;
  }
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.dy);
  const ms = computeTangents(xs, ys);
  for (let i = 0; i < n; i++) {
    const x = n > 1 ? i / (n - 1) : 0;
    out[i] = evalHermite(xs, ys, ms, x);
  }
  return out;
}

// ---- 周期スプライン（色相軸・x=0 と x=1 が繋がる円環） ----

/**
 * 周期軸用に入力点を整える：非周期 `cleanPoints`（ソート・重複統合）に加え、
 * 継ぎ目をまたいで先頭と末尾が円環距離 X_EPSILON 未満で一致する場合は末尾を落とす
 * （幅 0 のラップ区間による 0 割りを防ぐ）。x は [0,1) 前提だが範囲外もソートで整う。
 */
function cleanPointsPeriodic(points: readonly ControlPoint[]): ControlPoint[] {
  const pts = cleanPoints(points);
  if (pts.length >= 2) {
    // ラップ区間幅 = (x[0]+1) − x[k−1]。ほぼ 0 なら継ぎ目重複とみなし末尾を除去。
    if (pts[0].x + 1 - pts[pts.length - 1].x < X_EPSILON) pts.pop();
  }
  return pts;
}

/**
 * Fritsch–Carlson 接線を**円環**で計算する（前提：xs 昇順・長さ k≥2・x∈[0,1) 想定）。
 *
 * 割線は区間 i=[x_i, x_{i+1}]（i=k−1 は継ぎ目区間 [x_{k−1}, x_0+1]）で定義し、各ノードの
 * 接線は前後の割線を**円環インデックス**（(i−1+k)%k, (i+1)%k）で参照して作る。端点を特別扱い
 * しないため継ぎ目で C1 連続になる。全ノード値 0 なら全接線 0（後段 hermite が厳密 0 を返す）。
 */
function computeTangentsPeriodic(xs: readonly number[], ys: readonly number[]): number[] {
  const k = xs.length;
  const delta = new Array<number>(k);
  for (let i = 0; i < k; i++) {
    const x1 = i + 1 < k ? xs[i + 1] : xs[0] + 1;
    const y1 = i + 1 < k ? ys[i + 1] : ys[0];
    delta[i] = (y1 - ys[i]) / (x1 - xs[i]);
  }

  const m = new Array<number>(k);
  for (let i = 0; i < k; i++) {
    const dp = delta[(i - 1 + k) % k];
    const dn = delta[i];
    m[i] = dp * dn <= 0 ? 0 : (dp + dn) / 2;
  }

  // 円環の各区間で単調性領域 α²+β²≤9 に制限。
  for (let i = 0; i < k; i++) {
    const j = (i + 1) % k;
    if (delta[i] === 0) {
      m[i] = 0;
      m[j] = 0;
      continue;
    }
    const a = m[i] / delta[i];
    const b = m[j] / delta[i];
    const s = a * a + b * b;
    if (s > 9) {
      const tau = 3 / Math.sqrt(s);
      m[i] = tau * a * delta[i];
      m[j] = tau * b * delta[i];
    }
  }
  return m;
}

/** 準備済み円環ノードから x（任意・自動で [0,1) へラップ）の Hermite 値を返す。 */
function evalHermitePeriodic(
  xs: readonly number[],
  ys: readonly number[],
  ms: readonly number[],
  x: number,
): number {
  const k = xs.length;
  let xx = x - Math.floor(x); // → [0,1)
  // 継ぎ目区間 [x_{k−1}, x_0+1)：xx が最終点以上、または先頭点未満。
  if (xx >= xs[k - 1] || xx < xs[0]) {
    const xAdj = xx < xs[0] ? xx + 1 : xx;
    const h = xs[0] + 1 - xs[k - 1];
    const t = (xAdj - xs[k - 1]) / h;
    return hermite(ys[k - 1], ys[0], ms[k - 1], ms[0], h, t);
  }
  // 内部区間を線形走査。
  let i = 0;
  while (i < k - 2 && xx > xs[i + 1]) i++;
  const h = xs[i + 1] - xs[i];
  const t = (xx - xs[i]) / h;
  return hermite(ys[i], ys[i + 1], ms[i], ms[i + 1], h, t);
}

/**
 * 周期残差を x で評価（色相カーブ用）。点 0 個 → 0。点 1 個 → 全周でその dy を定数。
 * 複数点 → 円環 monotone-cubic Hermite（継ぎ目 C1 連続）。x は自動で [0,1) にラップ。
 */
export function evalResidualPeriodic(points: readonly ControlPoint[], x: number): number {
  const pts = cleanPointsPeriodic(points);
  if (pts.length === 0) return 0;
  if (pts.length === 1) return pts[0].dy;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.dy);
  const ms = computeTangentsPeriodic(xs, ys);
  return evalHermitePeriodic(xs, ys, ms, x);
}

/**
 * 周期残差を n 等分の格子 delta[i] = evalResidualPeriodic(points, i/n) で返す。
 * **周期軸なので x = i/n**（x=1 は x=0 と同一点）とし、接線計算は 1 度だけ行う。
 * 点 0 個 → 全 0、点 1 個 → 全要素その dy。
 */
export function sampleResidualToGridPeriodic(
  points: readonly ControlPoint[],
  n: number,
): Float32Array {
  const out = new Float32Array(n);
  const pts = cleanPointsPeriodic(points);
  if (pts.length === 0) return out;
  if (pts.length === 1) {
    out.fill(pts[0].dy);
    return out;
  }
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.dy);
  const ms = computeTangentsPeriodic(xs, ys);
  for (let i = 0; i < n; i++) {
    out[i] = evalHermitePeriodic(xs, ys, ms, i / n);
  }
  return out;
}

// ---- 空判定（RGB カーブ・色相カーブを独立に判定） ----

/** 1 チャンネルが「点なし」または「全 dy === 0」なら true（undefined も true）。 */
function isChannelEmpty(points?: readonly ControlPoint[]): boolean {
  if (!points || points.length === 0) return true;
  return points.every((p) => p.dy === 0);
}

/**
 * RGB カーブ（master/r/g/b）がすべて「点なし」または「全 dy === 0」なら true。
 * generateLut の残差カーブ加算（手順6）のスキップ判定に使う（ゴールデン・ビット一致保証）。
 */
export function isRgbCurvesEmpty(edits?: CurveEdits): boolean {
  if (!edits) return true;
  return (
    isChannelEmpty(edits.master) &&
    isChannelEmpty(edits.r) &&
    isChannelEmpty(edits.g) &&
    isChannelEmpty(edits.b)
  );
}

/**
 * 色相カーブ（hue/hueSat）がすべて「点なし」または「全 dy === 0」なら true。
 * generateLut の色相カーブ（手順5.5）のスキップ判定に使う（未編集ならビット一致）。
 */
export function isHueCurvesEmpty(edits?: CurveEdits): boolean {
  if (!edits) return true;
  return isChannelEmpty(edits.hue) && isChannelEmpty(edits.hueSat);
}

/**
 * 全カーブ（RGB ＋ 色相）が空／全 dy=0 なら true（undefined も true）。
 * true のとき generateLut はカーブ関連コードパスを一切通らない。
 */
export function isEmptyEdits(edits?: CurveEdits): boolean {
  return isRgbCurvesEmpty(edits) && isHueCurvesEmpty(edits);
}
