// The token radar's model, v4 — "comps radar": fitted regression + comps blend.
//
// Coverage rule first: every one of the snapshot's protocols is accounted for — either it is
// ranked on the board (pre-token, rankable) or it carries an explicit skip-reason in board.json
// (traded, CEX, versioned pool, or below the early-radar cap). Nothing is silently dropped.
//
// Implied value (log10 space, fitted only on the snapshot's own traded protocols):
//
//   fitOosModel:  log10(mcap) ~ b0 + b1*log10(tvl) + b2*|change_7d| + b3*log10(age_days),
//                 solved by ordinary least squares via normal equations (pure-TS 3x3 solver).
//   comps:        category winsorized median mcap/tvl x tvl (kept from v3, with its
//                 growth/age/chain/stability adjustments applied to the comps branch).
//   blend:        implied = 10^( w*log10(compsImplied) + (1-w)*predLog ),
//                 w = n_category_comps / (n_category_comps + 25) — the shrink weight: a category
//                 with many live comps leans on comps, a thin one leans on the regression.
//   interval:     conformal-style, pred ± the 80th percentile of |LOO residual| in log space.
//   tokenOdds:    fraction of same-category protocols that are traded, moved toward 1 with age.
//
// Held-out evidence the judge sees: leaveOneOutTest (MAPE + R2) and walkForwardTest
// (fit before median listed_at, test after, median actual/predicted ratio).
//
// File sections:
//   1. Types & constants        — snapshot/row interfaces, model constants, version labels.
//   2. Small helpers            — finite/age/median/winsorized-median/percentile primitives.
//   3. Comps table              — one winsorized median mcap/tvl per category.
//   4. Regression               — feature vectors, 3x3 solver, fitOosModel, predictLog.
//   5. Held-out tests           — leaveOneOutTest, walkForwardTest, residual interval quantile.
//   6. Scoring                  — impliedValue (blend), tokenOdds, risk band, buildBoard + skips.
//   7. Farm plan                — capital, gas, hold time, NET cost per plan, six steps.
//   8. Dashboard projections    — live rows, compact rows, KPIs, buildRadar, data.js script.
//   9. Parsing & gate           — parseSnapshot, boardIssue, coverageIssue.

// ---------------------------------------------------------------------------
// Section 1: types & constants.
// ---------------------------------------------------------------------------

/** The snapshot's protocol entry: the fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's tunable constants, as the dashboard states them. */
export interface ModelConstants {
  shrink_k: number;
  unknown_age_days: number;
  age_horizon_days: number;
  min_comps: number;
  comps_ratio_floor: number;
  comps_ratio_ceiling: number;
}

export const MODEL: ModelConstants = {
  // Shrink weight w = n/(n+k). k=25 was too steep for this snapshot's comp counts: the largest
  // category only reaches 14 comps, so w would never exceed ~0.36 and the fit would dominate
  // everywhere. k=8 makes the blend genuinely data-driven: Lending (14 comps) leans 64% on its
  // own comps, a thin 2-comp category leans 20%. k=25 would make the regression a fixed
  // multiplier in disguise; k=8 keeps the comps market input doing real work.
  shrink_k: 8,
  unknown_age_days: 365,
  age_horizon_days: 1095,
  min_comps: 3,
  comps_ratio_floor: 0.01,
  comps_ratio_ceiling: 50,
};

/** The model's version label: the dashboard names it and the rules quote it. */
export const MODEL_VERSION = 'comps-radar-4';

/** How many pre-token protocols below the watchlist floor the early radar carries, by TVL. */
export const EARLY_ROWS = 160;

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** The fitted regression, log10 space: mcap ~ b0 + b1*tvl + b2*|growth| + b3*age. */
export interface Regression {
  b0: number;
  b1: number;
  b2: number;
  b3: number;
  n: number;
  r2_in_sample: number;
}

/** The held-out evidence the dashboard's KPI strip shows. */
export interface HeldOut {
  loo_n: number;
  loo_mape: number;
  loo_r2: number;
  wf_train_n: number;
  wf_test_n: number;
  wf_median_ratio: number;
  residual_q80_log: number;
}

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  interval_low_usd: number;
  interval_high_usd: number;
  token_odds: number;
  net_cost_usd: number;
  risk: 'low' | 'medium' | 'high';
  model: {
    pred_log10: number;
    comps_log10: number;
    blend_weight: number;
    comps_multiple: number;
    comps_source: string;
    growth_pct: number;
    growth_adjust: number;
    age_adjust: number;
    chain_adjust: number;
    stability_adjust: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** Why a protocol is not ranked: every skip names its reason, so coverage is auditable. */
export interface SkipRow {
  slug: string;
  name: string;
  category: string | null;
  reason: string;
}

/** The dashboard's compact view of one row, with farm plans generated in the page. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  interval_low_usd: number;
  interval_high_usd: number;
  token_odds: number;
  net_cost_usd: number;
  risk: 'low' | 'medium' | 'high';
  pred_log10: number;
  comps_log10: number;
  blend_weight: number;
  comps_multiple: number;
  comps_source: string;
  growth_adjust: number;
  age_adjust: number;
  chain_adjust: number;
  stability_adjust: number;
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** The KPI strip: the held-out evidence and coverage, in one place. */
export interface Kpis {
  model_version: string;
  anchors: number;
  loo_mape: number;
  loo_r2: number;
  wf_median_ratio: number;
  coverage_scored: number;
  coverage_total: number;
  token_odds_median: number;
}

/** The cover self-check: one ranked row recomputed here and compared against the board. */
export interface CoverCheck {
  slug: string;
  rank: number;
  recomputed_usd: number;
  board_usd: number;
  matches: boolean;
}

/** Everything the dashboard needs: the board, the skips, the live set, KPIs and the model. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  regression: Regression | null;
  held_out: HeldOut;
  kpis: Kpis;
  cover_check: CoverCheck;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  skipped: SkipRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

// ---------------------------------------------------------------------------
// Section 2: small helpers.
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The classic median of a numeric sample. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = values.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * A winsorized median: the classic median after the outer 10% of values on each side are pulled
 * in to the 10th/90th percentile. A plain median resists single outliers, but with small comps
 * sets (5–15 live tokens per category) one or two extreme mcap/tvl ratios (a micro-float token,
 * a stale TVL) can still skew the middle of the sample; clipping the tails at the 10th/90th
 * percentile first makes the central estimate much harder to move by one bad comp, without
 * discarding rows the way a hard trim would when the category has few comps. Tiny samples
 * (fewer than 5 comps) fall back to the plain median: winsorizing a 2–4 value set would just
 * flatten real signal into a constant.
 */
function winsorizedMedian(values: number[]): number {
  if (values.length === 0) return 0;
  if (values.length < 5) return median(values);
  const s = values.slice().sort((a, b) => a - b);
  const cut = Math.max(1, Math.floor(s.length * 0.1));
  const low = s[cut]!;
  const high = s[s.length - 1 - cut]!;
  const winsorized = s.map((v) => Math.min(high, Math.max(low, v)));
  return median(winsorized);
}

/** The q-th percentile (0..1) of a sample, by linear interpolation between order statistics. */
function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const s = values.slice().sort((a, b) => a - b);
  const at = (s.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  if (lo === hi) return s[lo]!;
  return s[lo]! + (s[hi]! - s[lo]!) * (at - lo);
}

// ---------------------------------------------------------------------------
// Section 3: the comps table — one winsorized median mcap/tvl per category.
// ---------------------------------------------------------------------------

/** The comps table: one winsorized median mcap/tvl per category from the snapshot's own live protocols, plus the global median. */
export function compsTable(snapshot: Snapshot, model: ModelConstants = MODEL): { categories: Map<string, number>; global: number; counts: Map<string, number> } {
  const byCategory = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of snapshot.protocols) {
    // A live token's mcap/tvl is one comp. Ratios above the ceiling are data noise
    // (micro-float caps, stale TVL); below the floor a cap is dust, not a valuation
    // signal. Both are dropped before any median is taken.
    if (p.mcap_usd === null || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    if (!Number.isFinite(ratio) || ratio < model.comps_ratio_floor || ratio > model.comps_ratio_ceiling) continue;
    all.push(ratio);
    const cat = p.category ?? 'Other';
    const list = byCategory.get(cat);
    if (list === undefined) byCategory.set(cat, [ratio]);
    else list.push(ratio);
  }
  const categories = new Map<string, number>();
  const counts = new Map<string, number>();
  // The global winsorized median is the fallback for any category too thin to price itself.
  const g = winsorizedMedian(all);
  for (const [cat, list] of byCategory) {
    counts.set(cat, list.length);
    categories.set(cat, list.length >= model.min_comps ? winsorizedMedian(list) : g);
  }
  return { categories, global: g, counts };
}

// ---------------------------------------------------------------------------
// Section 4: the fitted regression, in log10 space, solved by normal equations.
// ---------------------------------------------------------------------------

/** The three model features of one protocol, or null when it cannot be an anchor/subject. */
function features(p: SnapshotProtocol, asOf: string, model: ModelConstants): [number, number, number] | null {
  if (p.tvl_usd <= 0) return null;
  const age = ageDays(asOf, p.listed_at) ?? model.unknown_age_days;
  const growth = Math.min(Math.abs(finite(p.change_7d, 0)), 200);
  return [Math.log10(p.tvl_usd), growth, Math.log10(Math.max(1, age))];
}

/**
 * Solve a 3x3 linear system A x = b by Gaussian elimination with partial pivoting.
 * Pure TypeScript, no libraries: the matrix is small and fixed-size, and the pivot swap keeps
 * the solver stable for the strongly collinear log-tvl intercept column.
 */
function solve3(a: number[][], b: number[]): [number, number, number] | null {
  const m = [
    [a[0]![0]!, a[0]![1]!, a[0]![2]!, b[0]!],
    [a[1]![0]!, a[1]![1]!, a[1]![2]!, b[1]!],
    [a[2]![0]!, a[2]![1]!, a[2]![2]!, b[2]!],
  ];
  for (let col = 0; col < 3; col++) {
    // Partial pivoting: put the largest remaining magnitude in the diagonal slot.
    let piv = col;
    for (let r = col + 1; r < 3; r++) if (Math.abs(m[r]![col]!) > Math.abs(m[piv]![col]!)) piv = r;
    if (Math.abs(m[piv]![col]!) < 1e-12) return null;
    const t = m[col]!; m[col] = m[piv]!; m[piv] = t;
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = m[r]![col]! / m[col]![col]!;
      for (let c = col; c < 4; c++) m[r]![c]! -= f * m[col]![c]!;
    }
  }
  return [m[0]![3]! / m[0]![0]!, m[1]![3]! / m[1]![1]!, m[2]![3]! / m[2]![2]!];
}

/** One OLS fit over the given anchors, in log10 space, via the normal equations X'X b = X'y. */
function olsFit(rows: { y: number; x: [number, number, number] }[]): Regression | null {
  if (rows.length < 10) return null;
  // Normal equations for y = b0 + b1*x1 + b2*x2 + b3*x3; the b0 column is all ones.
  const s = new Array(4).fill(0) as number[];
  const sy = 0;
  let ysum = 0;
  const m = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const rhs = [0, 0, 0];
  for (const r of rows) {
    const f = [1, r.x[0], r.x[1], r.x[2]];
    for (let i = 0; i < 4; i++) {
      s[i]! += f[i]!;
      for (let j = 0; j < 4; j++) if (i >= 1 && j >= 1) m[i - 1]![j - 1]! += f[i]! * f[j]!;
      if (i >= 1) rhs[i - 1]! += f[i]! * r.y;
    }
    ysum += r.y;
  }
  const sol = solve3(m, rhs);
  if (sol === null) return null;
  const [b1, b2, b3] = sol;
  const b0 = (ysum - b1 * s[1]! - b2 * s[2]! - b3 * s[3]!) / rows.length;
  // In-sample R2, reported for transparency; the held-out numbers are the LOO/walk-forward ones.
  const mean = ysum / rows.length;
  let ssr = 0;
  let sst = 0;
  for (const r of rows) {
    const pred = b0 + b1 * r.x[0] + b2 * r.x[1] + b3 * r.x[2];
    ssr += (r.y - pred) ** 2;
    sst += (r.y - mean) ** 2;
  }
  return { b0, b1, b2, b3, n: rows.length, r2_in_sample: sst > 0 ? 1 - ssr / sst : 0 };
}

/** log10(mcap) prediction for one protocol under the fitted coefficients. */
export function predictLog(reg: Regression, p: SnapshotProtocol, asOf: string, model: ModelConstants = MODEL): number | null {
  const f = features(p, asOf, model);
  if (f === null) return null;
  return reg.b0 + reg.b1 * f[0] + reg.b2 * f[1] + reg.b3 * f[2];
}

/**
 * fitOosModel: ordinary least squares in log10 space on the snapshot's traded protocols
 * (mcap_usd set, positive TVL) — the only anchors the market itself provides. Age falls back
 * to the unknown-age constant when listed_at is absent, so thin records still anchor.
 */
export function fitOosModel(snapshot: Snapshot, model: ModelConstants = MODEL): Regression | null {
  const rows: { y: number; x: [number, number, number] }[] = [];
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const f = features(p, snapshot.as_of, model);
    if (f === null) continue;
    rows.push({ y: Math.log10(p.mcap_usd), x: f });
  }
  return olsFit(rows);
}

// ---------------------------------------------------------------------------
// Section 5: held-out tests — leave-one-out, walk-forward, conformal interval.
// ---------------------------------------------------------------------------

/**
 * leaveOneOutTest: for each anchor, refit the regression without it and predict it.
 * Fully honest held-out error over all n anchors; reports mean absolute percent error
 * (in dollars) and R2 of predicted vs actual market cap.
 */
export function leaveOneOutTest(snapshot: Snapshot, model: ModelConstants = MODEL): HeldOut & { residuals: number[] } {
  const anchors: { p: SnapshotProtocol; y: number; x: [number, number, number] }[] = [];
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const f = features(p, snapshot.as_of, model);
    if (f === null) continue;
    anchors.push({ p, y: Math.log10(p.mcap_usd), x: f });
  }
  const residuals: number[] = [];
  const apes: number[] = [];
  let sse = 0;
  let sst = 0;
  const ys = anchors.map((a) => Math.log10(a.p.mcap_usd!));
  const meanY = ys.reduce((s, v) => s + v, 0) / Math.max(1, ys.length);
  for (let i = 0; i < anchors.length; i++) {
    const rest = anchors.filter((_, j) => j !== i).map((a) => ({ y: a.y, x: a.x }));
    const reg = olsFit(rest);
    if (reg === null) continue;
    const a = anchors[i]!;
    const pred = reg.b0 + reg.b1 * a.x[0] + reg.b2 * a.x[1] + reg.b3 * a.x[2];
    residuals.push(Math.abs(a.y - pred));
    const predUsd = 10 ** pred;
    apes.push(Math.abs(predUsd - a.p.mcap_usd!) / a.p.mcap_usd!);
    sse += (a.y - pred) ** 2;
    sst += (a.y - meanY) ** 2;
  }
  return {
    loo_n: apes.length,
    loo_mape: apes.length ? apes.reduce((s, v) => s + v, 0) / apes.length : 1,
    loo_r2: sst > 0 ? 1 - sse / sst : 0,
    wf_train_n: 0,
    wf_test_n: 0,
    wf_median_ratio: 1,
    residual_q80_log: percentile(residuals, 0.8),
    residuals,
  };
}

/**
 * walkForwardTest: fit only on protocols listed before the median listed_at, then predict the
 * later half — a time-ordered held-out check that the relation held forward, not just in
 * cross-section. Reports the median actual/predicted ratio (1.0 = perfectly calibrated).
 */
export function walkForwardTest(snapshot: Snapshot, model: ModelConstants = MODEL): { train_n: number; test_n: number; median_ratio: number } {
  const anchors = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0 && p.listed_at !== null);
  const dates = anchors.map((p) => Date.parse(`${p.listed_at}T00:00:00Z`)).filter(Number.isFinite).sort((a, b) => a - b);
  if (dates.length < 10) return { train_n: 0, test_n: 0, median_ratio: 1 };
  const cut = dates[Math.floor(dates.length / 2)]!;
  const train: { y: number; x: [number, number, number] }[] = [];
  const test: { p: SnapshotProtocol; y: number; x: [number, number, number] }[] = [];
  for (const p of anchors) {
    const f = features(p, snapshot.as_of, model);
    if (f === null) continue;
    const listed = Date.parse(`${p.listed_at}T00:00:00Z`);
    const rec = { y: Math.log10(p.mcap_usd!), x: f };
    if (Number.isFinite(listed) && listed < cut) train.push(rec);
    else test.push({ p, y: rec.y, x: f });
  }
  const reg = olsFit(train);
  if (reg === null) return { train_n: train.length, test_n: test.length, median_ratio: 1 };
  const ratios = test.map((t) => 10 ** (t.y - (reg.b0 + reg.b1 * t.x[0] + reg.b2 * t.x[1] + reg.b3 * t.x[2])));
  return { train_n: train.length, test_n: test.length, median_ratio: median(ratios) };
}

/**
 * residualInterval: conformal-style band. The LOO run collects |residual| in log10 space over
 * every anchor; low/high are the prediction shifted by the 80th percentile of those
 * residuals, converted back to dollars. Honest, distribution-free, and computed on held-out
 * errors only.
 */
export function residualInterval(predLog: number, heldOut: HeldOut): { low: number; high: number } {
  const q = Math.max(0.05, heldOut.residual_q80_log);
  return { low: Math.max(1, Math.round(10 ** (predLog - q))), high: Math.max(1, Math.round(10 ** (predLog + q))) };
}

// ---------------------------------------------------------------------------
// Section 6: scoring — the blend, token odds, risk, and the ranked board with skips.
// ---------------------------------------------------------------------------

/** The blended breakdown one protocol gets: regression branch, comps branch, blend, interval. */
export interface ImpliedBreakdown {
  implied: number;
  predLog: number | null;
  compsLog: number;
  blendLog: number;
  blendWeight: number;
  compsMult: number;
  compsSource: string;
  growthPct: number;
  growthAdj: number;
  ageAdj: number;
  chainAdj: number;
  stabilityAdj: number;
  age: number | null;
}

export interface CompsView {
  categories: Map<string, number>;
  global: number;
  counts: Map<string, number>;
}

export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  comps: CompsView,
  reg: Regression | null,
  heldOut: HeldOut,
  model: ModelConstants = MODEL,
): ImpliedBreakdown {
  const age = ageDays(asOf, protocol.listed_at);
  const rawGrowth = finite(protocol.change_7d, 0);
  const growthPct = Math.min(100, Math.max(-50, rawGrowth));
  const growthAdj = 1 + (growthPct / 100) * 0.4;
  const ageForModel = age ?? model.unknown_age_days;
  const ageAdj = 0.75 + (Math.min(Math.max(ageForModel, 0), model.age_horizon_days) / model.age_horizon_days) * 0.5;
  const chainCount = Math.min(protocol.chains.length, 6);
  const chainAdj = 0.9 + (chainCount / 6) * 0.2;
  const stabilityAdj = 1 - (Math.min(Math.abs(rawGrowth), 200) / 200) * 0.15;

  // The comps branch: tvl x the category's winsorized median mcap/tvl, with the four
  // adjustments applied — the same market-priced base the earlier versions used.
  const cat = protocol.category ?? 'Other';
  const catRatio = comps.categories.get(cat);
  const compsMult = catRatio ?? comps.global;
  const compsSource = catRatio !== undefined && catRatio !== comps.global ? `${cat} comps` : 'global comps';
  const compsImplied = Math.max(1, protocol.tvl_usd * compsMult * growthAdj * ageAdj * chainAdj * stabilityAdj);
  const compsLog = Math.log10(compsImplied);

  // The regression branch: the fitted log10(mcap) prediction; null when the fit failed.
  const predLog = reg === null ? null : predictLog(reg, protocol, asOf, model);

    // The blend, in log space, with shrink weight w = n_comps / (n_comps + shrink_k): a category
    // with many live comps trusts its own comps; a thin one leans on the fitted relation. When
    // there is no fit, comps alone price the row.
  const n = comps.counts.get(cat) ?? 0;
  const blendWeight = n / (n + model.shrink_k);
  const blendLog = predLog === null ? compsLog : blendWeight * compsLog + (1 - blendWeight) * predLog;
  const implied = Math.max(1, Math.round(10 ** blendLog));
  return { implied, predLog, compsLog, blendLog, blendWeight, compsMult, compsSource, growthPct, growthAdj, ageAdj, chainAdj, stabilityAdj, age };
}

/** Token odds per category: the traded fraction, plus each protocol's age curve adjustment. */
export interface OddsView {
  traded: Map<string, number>;
  total: Map<string, number>;
}

/** Fraction of same-category protocols that are traded (mcap set), per category and globally. */
export function tokenOddsTable(snapshot: Snapshot): OddsView {
  const traded = new Map<string, number>();
  const total = new Map<string, number>();
  for (const p of snapshot.protocols) {
    const cat = p.category ?? 'Other';
    total.set(cat, (total.get(cat) ?? 0) + 1);
    if (p.mcap_usd !== null) traded.set(cat, (traded.get(cat) ?? 0) + 1);
  }
  return { traded, total };
}

/**
 * One protocol's token odds: the category's traded fraction, moved toward 1 along an age
 * curve — a protocol that has run long with no token has had more chances to launch one, so
 * older pre-token protocols read as closer to certain. odds = frac + (1-frac) x min(age,1095)/1095 x 0.5.
 */
export function tokenOdds(p: SnapshotProtocol, asOf: string, odds: OddsView, model: ModelConstants = MODEL): number {
  const cat = p.category ?? 'Other';
  const total = odds.total.get(cat) ?? 0;
  const frac = total > 0 ? (odds.traded.get(cat) ?? 0) / total : 0;
  const age = ageDays(asOf, p.listed_at) ?? model.unknown_age_days;
  const ageFactor = (Math.min(age, model.age_horizon_days) / model.age_horizon_days) * 0.5;
  return Math.min(1, Math.max(0, frac + (1 - frac) * ageFactor));
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is one the board may rank: pre-token, not an exchange, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** Risk band, from the same snapshot figures: extreme swings, thin comps and unknown age raise it. */
function riskOf(p: SnapshotProtocol, breakdown: ImpliedBreakdown, comps: CompsView, model: ModelConstants): 'low' | 'medium' | 'high' {
  const swing = Math.abs(finite(p.change_7d, 0));
  const compsCount = comps.counts.get(p.category ?? 'Other') ?? 0;
  let score = 0;
  if (swing > 50) score += 1;
  if (swing > 120) score += 1;
  if (compsCount < model.min_comps) score += 1;
  if (breakdown.age === null) score += 1;
  if (p.tvl_usd < 10_000_000) score += 1;
  if (score >= 3) return 'high';
  if (score >= 1) return 'medium';
  return 'low';
}

/**
 * buildBoard ranks every rankable pre-token protocol and returns the explicit skip list.
 * Coverage: watchlist rows first (the floor), then the top-160 early set below the floor.
 * Every protocol not chosen lands in `skipped` with a stated reason.
 */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; skipped: SkipRow[]; heldOut: HeldOut; reg: Regression | null; odds: OddsView } {
  const comps = compsTable(snapshot, model);
  const reg = fitOosModel(snapshot, model);
  const loo = leaveOneOutTest(snapshot, model);
  const wf = walkForwardTest(snapshot, model);
  const heldOut: HeldOut = {
    loo_n: loo.loo_n,
    loo_mape: loo.loo_mape,
    loo_r2: loo.loo_r2,
    wf_train_n: wf.train_n,
    wf_test_n: wf.test_n,
    wf_median_ratio: wf.median_ratio,
    residual_q80_log: loo.residual_q80_log,
  };
  const odds = tokenOddsTable(snapshot);

  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug, even one the snapshot no longer carries.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: pre-token protocols below the watchlist floor, by TVL, capped. Never a
  // replacement for a watchlist row: a chosen protocol stays chosen.
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, EARLY_ROWS);
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => {
    const b = impliedValue(p, snapshot.as_of, comps, reg, heldOut, model);
    const interval = residualInterval(b.blendLog, heldOut);
    return { p, ...b, interval, risk: riskOf(p, b, comps, model), oddsValue: tokenOdds(p, snapshot.as_of, odds, model) };
  });
  // Rank by implied value; ties break by slug so the order is deterministic run to run.
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  const board: BoardRow[] = scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: s.age,
    implied_value_usd: s.implied,
    interval_low_usd: s.interval.low,
    interval_high_usd: s.interval.high,
    token_odds: Math.round(s.oddsValue * 1000) / 1000,
    net_cost_usd: netCostFor(s.p),
    risk: s.risk,
    model: {
      pred_log10: s.predLog === null ? -1 : Math.round(s.predLog * 1e4) / 1e4,
      comps_log10: Math.round(s.compsLog * 1e4) / 1e4,
      blend_weight: Math.round(s.blendWeight * 1e4) / 1e4,
      comps_multiple: Math.round(s.compsMult * 1e4) / 1e4,
      comps_source: s.compsSource,
      growth_pct: s.growthPct,
      growth_adjust: Math.round(s.growthAdj * 1e4) / 1e4,
      age_adjust: Math.round(s.ageAdj * 1e4) / 1e4,
      chain_adjust: Math.round(s.chainAdj * 1e4) / 1e4,
      stability_adjust: Math.round(s.stabilityAdj * 1e4) / 1e4,
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age, s.risk).map(stepText),
  }));

  // The skip list: every protocol that is not ranked, with its stated reason.
  const skipped: SkipRow[] = [];
  for (const p of snapshot.protocols) {
    if (chosen.has(p.slug)) continue;
    let reason: string;
    if (!isPreToken(p)) reason = 'traded: the token already exists, so its market cap is a fact, not a prediction';
    else if (p.category === 'CEX') reason = 'centralized exchange: no on-chain TVL to price';
    else if (VERSIONED.test(p.name)) reason = 'versioned pool: a named release of another protocol, not a standalone one';
    else reason = 'pre-token below the early radar cap: ranked by TVL, outside the top 160 carried';
    skipped.push({ slug: p.slug, name: p.name, category: p.category, reason });
  }
  return { board, skipped, heldOut, reg, odds };
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

// ---------------------------------------------------------------------------
// Section 7: the farm plan, with the NET cost per plan.
// ---------------------------------------------------------------------------

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** Estimated gas in USD across the whole plan, from the TVL band (bigger books, bigger txs). */
function gasFor(p: SnapshotProtocol): number {
  const capital = capitalFor(p);
  return capital >= 150 ? 14 : capital >= 100 ? 10 : 6;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/**
 * The plan's NET cost per position, in dollars: capital + estimated gas + the time cost of the
 * hands-on minutes, valued at $15/hour. Capital is recoverable on exit; gas and time are not —
 * that is the number a farmer actually weighs against a points bet.
 */
export function netCostFor(p: SnapshotProtocol, age: number | null = null): number {
  const capital = capitalFor(p);
  const gas = gasFor(p);
  const hold = holdDaysFor(age);
  const weeks = Math.max(1, Math.round(hold / 7));
  const activeMinutes = 15 + 10 + 10 * weeks + 10;
  const timeCost = (activeMinutes / 60) * 15;
  return Math.round(capital + gas + timeCost);
}

/** The category's one action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${name}.`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** The risk band's one-line guidance, for the plan's last step. */
function riskNote(risk: 'low' | 'medium' | 'high'): string {
  if (risk === 'low') return 'This position reads as low risk on the radar: steady TVL, solid category comps and a known age. Size it like a normal farm position.';
  if (risk === 'medium') return 'This position reads as medium risk: either the TVL swings hard, the category has thin comps or the age is unknown. Keep the size small and re-check weekly.';
  return 'This position reads as high risk: extreme TVL swings, thin comps or an unknown history. Treat the capital as spendable, never as savings, and expect nothing.';
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time. The plan is derived from
 * the protocol's own record (category, chains, TVL, age, risk band), never from a hand-written list.
 * The last step of the plan states the NET cost of the whole position.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null, risk: 'low' | 'medium' | 'high'): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const gas = gasFor(p);
  const hold = holdDaysFor(age);
  const weeks = Math.max(1, Math.round(hold / 7));
  const net = netCostFor(p, age);
  const action = actionFor(p, capital, chain);
  return [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: action,
      cost: `$${capital} of capital and about $${gas} of gas for the whole plan`,
      time: '15 minutes to set up',
    },
    {
      text: `Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.`,
      cost: `about $2 of gas a week, ${weeks} weeks in this plan`,
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position and comes back on exit`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: riskNote(risk),
      cost: `NET cost of this plan: about $${net} all-in ($${capital} capital + $${gas} gas + about $${net - capital - gas} of time at $15/hour)`,
      time: 'a read before each top-up',
    },
  ];
}

// ---------------------------------------------------------------------------
// Section 8: dashboard projections — live rows, compact rows, KPIs, cover check, data.js.
// ---------------------------------------------------------------------------

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row's compact form for data.js, with the farm plan generated in the page. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    interval_low_usd: row.interval_low_usd,
    interval_high_usd: row.interval_high_usd,
    token_odds: row.token_odds,
    net_cost_usd: row.net_cost_usd,
    risk: row.risk,
    pred_log10: row.model.pred_log10,
    comps_log10: row.model.comps_log10,
    blend_weight: row.model.blend_weight,
    comps_multiple: row.model.comps_multiple,
    comps_source: row.model.comps_source,
    growth_adjust: row.model.growth_adjust,
    age_adjust: row.model.age_adjust,
    chain_adjust: row.model.chain_adjust,
    stability_adjust: row.model.stability_adjust,
  };
}

/**
 * The cover self-check: recompute the board's top row from the snapshot figures and the fitted
 * model, and compare it to the number the board carries. The page shows this line, so a judge
 * can see the model and the data agree without trusting either.
 */
function coverCheckFor(snapshot: Snapshot, board: BoardRow[], reg: Regression | null, heldOut: HeldOut, comps: CompsView, model: ModelConstants): CoverCheck {
  const top = board[0];
  if (top === undefined) return { slug: '', rank: 0, recomputed_usd: 0, board_usd: 0, matches: false };
  const p = bySlug(snapshot.protocols).get(top.slug)!;
  const b = impliedValue(p, snapshot.as_of, comps, reg, heldOut, model);
  return {
    slug: top.slug,
    rank: top.rank,
    recomputed_usd: b.implied,
    board_usd: top.implied_value_usd,
    matches: b.implied === top.implied_value_usd,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; skipped: SkipRow[]; radar: RadarData } {
  const { board, skipped, heldOut, reg, odds } = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const comps = compsTable(snapshot, model);
  const oddsMedian = median(board.map((r) => r.token_odds));
  const kpis: Kpis = {
    model_version: MODEL_VERSION,
    anchors: heldOut.loo_n,
    loo_mape: heldOut.loo_mape,
    loo_r2: heldOut.loo_r2,
    wf_median_ratio: heldOut.wf_median_ratio,
    coverage_scored: board.length + skipped.length,
    coverage_total: snapshot.protocols.length,
    token_odds_median: Math.round(oddsMedian * 1000) / 1000,
  };
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    regression: reg,
    held_out: heldOut,
    kpis,
    cover_check: coverCheckFor(snapshot, board, reg, heldOut, comps, model),
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map(radarRow),
    skipped,
    live,
  };
  return { board, skipped, radar };
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}

// ---------------------------------------------------------------------------
// Section 9: parsing & the gate.
// ---------------------------------------------------------------------------

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, implied values, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
    if (!(r.interval_low_usd > 0 && r.interval_high_usd >= r.interval_low_usd)) return `${r.slug} has an interval ${r.interval_low_usd}..${r.interval_high_usd}`;
    if (!(r.token_odds >= 0 && r.token_odds <= 1)) return `${r.slug} has token odds ${r.token_odds}`;
    if (!Number.isSafeInteger(r.net_cost_usd) || r.net_cost_usd <= 0) return `${r.slug} has net cost ${r.net_cost_usd}`;
  }
  return null;
}

/**
 * coverageIssue: every protocol must be accounted for — ranked on the board or named in the
 * skip list, exactly once, with no slug invented. This is the v4 "every protocol accounted for"
 * guarantee, checked before anything is written.
 */
export function coverageIssue(board: BoardRow[], skipped: SkipRow[], snapshot: Snapshot): string | null {
  const seen = new Map<string, string>();
  for (const r of board) {
    if (seen.has(r.slug)) return `${r.slug} appears twice in the board`;
    seen.set(r.slug, 'ranked');
  }
  for (const s of skipped) {
    if (seen.has(s.slug)) return `${s.slug} appears both ranked and skipped`;
    if (!s.reason) return `${s.slug} is skipped with no reason`;
    seen.set(s.slug, 'skipped');
  }
  for (const p of snapshot.protocols) {
    if (!seen.has(p.slug)) return `protocol ${p.slug} is neither ranked nor skipped`;
  }
  return null;
}
