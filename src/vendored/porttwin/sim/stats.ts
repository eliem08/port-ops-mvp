/**
 * Small-sample statistics for simulation output analysis.
 *
 * Textbook basis: Law & Kelton, "Simulation Modeling and Analysis"
 * (5th ed., McGraw-Hill, 2015), Ch. 9 — confidence intervals on the mean of
 * i.i.d. replication outputs use the Student-t distribution, NOT the normal
 * approximation, whenever the number of replications is modest. The old
 * 1.96 factor is only the df → ∞ limit; with n = 10 replications the correct
 * multiplier is t(0.975, 9) = 2.262, i.e. ~15% wider. Using 1.96 with few
 * replications understates uncertainty.
 *
 * The t-quantile is computed by bisection on the t CDF, which is expressed
 * through the regularized incomplete beta function (Numerical Recipes
 * `betacf` continued-fraction evaluation). No lookup tables, no
 * approximations that degrade at small df.
 */

/** Arithmetic mean. Returns NaN for an empty array. */
export function mean(values: number[]): number {
  if (values.length === 0) return NaN;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/** Sample variance (denominator n − 1). Returns NaN for n < 2. */
export function sampleVariance(values: number[]): number {
  const n = values.length;
  if (n < 2) return NaN;
  const m = mean(values);
  return values.reduce((s, v) => s + (v - m) * (v - m), 0) / (n - 1);
}

/** Sample standard deviation. Returns NaN for n < 2. */
export function sampleStd(values: number[]): number {
  return Math.sqrt(sampleVariance(values));
}

/** Continued fraction for the incomplete beta function (Numerical Recipes). */
function betacf(a: number, b: number, x: number): number {
  const MAXIT = 200;
  const EPS = 3e-14;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    // Even step.
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    // Odd step.
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Log-gamma via the Lanczos approximation (g = 7, n = 9 coefficients). */
function logGamma(z: number): number {
  const p = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) {
    // Reflection formula.
    return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - logGamma(1 - z);
  }
  const zz = z - 1;
  let x = p[0];
  for (let i = 1; i < 9; i++) x += p[i] / (zz + i);
  const t = zz + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (zz + 0.5) * Math.log(t) - t + Math.log(x);
}

/**
 * Regularized incomplete beta function I_x(a, b).
 * Throws on out-of-range inputs.
 */
export function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (x < 0 || x > 1) throw new Error("regularizedIncompleteBeta: x must be in [0, 1]");
  if (x === 0 || x === 1) return x;
  const bt = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) +
      a * Math.log(x) + b * Math.log(1 - x)
  );
  if (x < (a + 1) / (a + b + 2)) {
    return (bt * betacf(a, b, x)) / a;
  }
  return 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** CDF of the Student-t distribution with `df` degrees of freedom. */
export function tCdf(t: number, df: number): number {
  if (!Number.isFinite(t) || df <= 0) throw new Error("tCdf: invalid input");
  const x = df / (df + t * t);
  const ib = regularizedIncompleteBeta(x, df / 2, 0.5);
  return t >= 0 ? 1 - 0.5 * ib : 0.5 * ib;
}

/**
 * Quantile (inverse CDF) of the Student-t distribution.
 * Bisection to ~1e-10; accurate for df ≥ 1 and p in (0, 1).
 */
export function tQuantile(p: number, df: number): number {
  if (!(p > 0 && p < 1)) throw new Error("tQuantile: p must be in (0, 1)");
  if (df <= 0) throw new Error("tQuantile: df must be positive");
  if (p === 0.5) return 0;
  // Bracket: t-CDF is monotone; widen until the bracket contains p.
  let lo = -1;
  let hi = 1;
  while (tCdf(lo, df) > p) lo *= 2;
  while (tCdf(hi, df) < p) hi *= 2;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (tCdf(mid, df) < p) lo = mid;
    else hi = mid;
    if (hi - lo < 1e-10) break;
  }
  return (lo + hi) / 2;
}

/** Two-sided 95% t critical value for `df` degrees of freedom. */
export function tCritical95(df: number): number {
  return tQuantile(0.975, df);
}

/**
 * Standard normal CDF via the Abramowitz–Stegun erf approximation
 * (|ε| ≤ 1.5e−7). Used for exact lognormal truncated expectations.
 */
export function normalCdf(x: number): number {
  // erf(x) approximation, A&S 7.1.26.
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * ax);
  const poly =
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t -
      0.284496736) * t +
      0.254829592) * t;
  const erf = sign * (1 - poly * Math.exp(-ax * ax));
  return 0.5 * (1 + erf);
}

/**
 * E[max(floor, X)] for X lognormal with desired mean `mean` and shape
 * `sigma` — the exact expectation of the engine's floored service-time
 * draw (the floor raises the mean slightly; ignoring it biases V&V).
 */
export function flooredLognormalMean(
  meanValue: number,
  sigma: number,
  floor: number
): number {
  const m = Math.log(meanValue) - (sigma * sigma) / 2;
  const pBelow = normalCdf((Math.log(floor) - m) / sigma);
  const pAboveTerm = normalCdf((m + sigma * sigma - Math.log(floor)) / sigma);
  return floor * pBelow + meanValue * pAboveTerm;
}

/**
 * E[max(1, X)] for X exponential with mean `mu`:
 * 1 + μ·e^(−1/μ). The engine floors berth service at 1 minute.
 */
export function flooredExponentialMean(mu: number): number {
  return 1 + mu * Math.exp(-1 / mu);
}

export interface ConfidenceInterval {
  n: number;
  mean: number;
  std: number;
  /** Half-width of the interval. */
  halfWidth: number;
  ciLow: number;
  ciHigh: number;
  /** Critical value actually used (t with df = n − 1). */
  tCritical: number;
}

/**
 * Two-sided confidence interval for the mean of i.i.d. observations,
 * using the Student-t distribution (Law & Kelton Ch. 9). For n = 1 the
 * interval degenerates to the single observation (std undefined).
 */
export function confidenceInterval(
  values: number[],
  confidence = 0.95
): ConfidenceInterval {
  const n = values.length;
  if (n === 0) throw new Error("confidenceInterval: need at least one observation");
  const m = mean(values);
  if (n === 1) {
    return { n, mean: m, std: 0, halfWidth: 0, ciLow: m, ciHigh: m, tCritical: NaN };
  }
  const s = sampleStd(values);
  const alpha = 1 - confidence;
  const tCrit = tQuantile(1 - alpha / 2, n - 1);
  const halfWidth = (tCrit * s) / Math.sqrt(n);
  return {
    n,
    mean: m,
    std: s,
    halfWidth,
    ciLow: m - halfWidth,
    ciHigh: m + halfWidth,
    tCritical: tCrit,
  };
}
