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

/** 4 チャンネル分の編集。master はガンマ空間 Rec.709 luma を入力軸とし全チャンネルへ同量加算される。 */
export interface CurveEdits {
  master: ControlPoint[];
  r: ControlPoint[];
  g: ControlPoint[];
  b: ControlPoint[];
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
  const t2 = t * t;
  const t3 = t2 * t;
  // Hermite 基底関数。
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  return h00 * ys[i] + h10 * h * ms[i] + h01 * ys[i + 1] + h11 * h * ms[i + 1];
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

/** 1 チャンネルが「点なし」または「全 dy === 0」なら true（undefined も true）。 */
function isChannelEmpty(points?: readonly ControlPoint[]): boolean {
  if (!points || points.length === 0) return true;
  return points.every((p) => p.dy === 0);
}

/**
 * 全チャンネルが「点なし」または「全 dy === 0」なら true（undefined も true）。
 * true のとき generateLut は残差コードパスを一切通らない（ゴールデンのビット一致保証に使う）。
 */
export function isEmptyEdits(edits?: CurveEdits): boolean {
  if (!edits) return true;
  return (
    isChannelEmpty(edits.master) &&
    isChannelEmpty(edits.r) &&
    isChannelEmpty(edits.g) &&
    isChannelEmpty(edits.b)
  );
}
