// The complexity classifier: given cost at several sizes, what shape is it?
//
// This is the piece the whole harness rests on, which is why it runs against
// synthetic workloads of known shape before it is allowed to rule on anything
// real (`controls.mjs`). A classifier that cannot tell O(n) from O(n²) on an
// input built to be one or the other has no business ruling on a crossing.
//
// **Why decade steps.** Sizes are spaced by factors of ten, and the exponent is
// read off consecutive pairs as log(t₂/t₁) / log(n₂/n₁). That spacing is not
// cosmetic — it is what makes the estimate survive a noisy laptop. A relative
// measurement error of e propagates to an exponent error of about 2e/ln(10) ≈
// 0.87e, so even a 10% noise floor moves the exponent by under 0.09, against
// class boundaries that are 0.5 apart. Two-fold spacing would multiply that
// error by 3.3 and put a linear cell within reach of the quadratic band.
//
// **Why the largest pair decides.** t(n) = a + b·n has a log-log slope that is
// depressed at small n, where the constant a dominates: a genuinely linear
// crossing measured at n=10 vs n=100 can look sublinear purely because the
// per-call overhead has not yet been amortised. The asymptotic pair is the one
// that answers the question actually being asked ("what does this cost as the
// input grows"), so it decides the class and the earlier pairs are reported
// beside it as evidence.
//
// **Why CONSTANT needs a witness.** Every other class proves it did work by
// costing more at larger n. A cell claiming CONSTANT proves nothing that way —
// flatness is indistinguishable from a knob wired to nothing, which is the
// CR-23 F4 shape and the single most convincing way this harness could report
// a clean result while searching nothing. So a CONSTANT declaration must supply
// a `witness`: some *other* quantity that demonstrably moves when the knob
// does. No witness, no verdict — the cell reports VACUOUS.

export const CLASSES = ['CONSTANT', 'LINEAR', 'QUADRATIC', 'SUPER-QUADRATIC'];

// Boundaries sit midway between the exponents they separate (0, 1, 2, 3), with
// the constant/linear line pulled down to 0.35: a real O(1) crossing measured
// through a noisy per-call overhead drifts up more readily than a real O(n)
// drifts down.
export function classOf(exponent) {
  if (exponent < 0.35) return 'CONSTANT';
  if (exponent < 1.45) return 'LINEAR';
  if (exponent < 2.5) return 'QUADRATIC';
  return 'SUPER-QUADRATIC';
}

export function exponentBetween(n1, t1, n2, t2) {
  if (!(n2 > n1) || t1 <= 0 || t2 <= 0) return NaN;
  return Math.log(t2 / t1) / Math.log(n2 / n1);
}

// points: [{ n, ns }, ...] ascending in n, at least two.
// declared: the expected class, or null to just report.
// noise: the measured noise floor, as a relative figure.
// witness: for a CONSTANT declaration, evidence the knob was connected —
//          { label, moved: boolean }.
export function classify(points, { declared = null, noise = 0.05, witness = null } = {}) {
  const pts = [...points].sort((a, b) => a.n - b.n);
  if (pts.length < 2) {
    return { verdict: 'VACUOUS', reason: 'fewer than two sizes measured', pts };
  }

  const pairs = [];
  for (let i = 1; i < pts.length; i++) {
    pairs.push({
      from: pts[i - 1].n,
      to: pts[i].n,
      ratio: pts[i].ns / pts[i - 1].ns,
      exponent: exponentBetween(pts[i - 1].n, pts[i - 1].ns, pts[i].n, pts[i].ns),
    });
  }
  const last = pairs[pairs.length - 1];
  const exponent = last.exponent;
  if (!Number.isFinite(exponent)) {
    return { verdict: 'VACUOUS', reason: 'non-finite exponent (a zero or negative timing)', pts, pairs };
  }

  const observed = classOf(exponent);
  const first = pts[0];
  const largest = pts[pts.length - 1];
  const growth = largest.ns / first.ns;

  // Per-cell vacuity. Everything except a CONSTANT declaration must show that
  // the largest size cost measurably more than the smallest; otherwise the
  // workload did not scale and the cell measured its own overhead.
  if (declared !== 'CONSTANT') {
    if (growth - 1 <= noise) {
      return {
        verdict: 'VACUOUS',
        reason: `cost at n=${largest.n} is within the ${(noise * 100).toFixed(1)}% noise floor of n=${first.n}`
          + ' — the workload did not scale, so nothing was measured',
        exponent, observed, pts, pairs,
      };
    }
  } else if (!witness || !witness.moved) {
    return {
      verdict: 'VACUOUS',
      reason: 'a CONSTANT declaration needs a witness proving the knob is connected;'
        + (witness ? ` witness "${witness.label}" did not move` : ' none was supplied'),
      exponent, observed, pts, pairs,
    };
  }

  if (declared === null) return { verdict: 'REPORTED', exponent, observed, pts, pairs, witness };
  const verdict = observed === declared ? 'PASS' : 'FAIL';
  return {
    verdict,
    exponent,
    observed,
    declared,
    growth,
    pts,
    pairs,
    witness,
    reason: verdict === 'FAIL'
      ? `declared ${declared}, measured ${observed} (exponent ${exponent.toFixed(2)} over n=${last.from}→${last.to})`
      : undefined,
  };
}

// A ratio assertion with the noise floor folded in: "is a about `expect` times
// b?" `tolerance` is a multiplicative band — 0.35 accepts 6.5x..13.5x for an
// expected 10x.
export function ratioVerdict(a, b, expect, { tolerance = 0.35, noise = 0.05 } = {}) {
  if (b <= 0) return { verdict: 'VACUOUS', reason: 'divisor is zero' };
  const ratio = a / b;
  const lo = expect * (1 - tolerance);
  const hi = expect * (1 + tolerance);
  // A ratio whose distance from 1 is inside the noise floor is not a ratio.
  if (Math.abs(ratio - 1) <= noise && Math.abs(expect - 1) > noise) {
    return { verdict: 'VACUOUS', ratio, reason: `ratio ${ratio.toFixed(3)} is inside the noise floor; expected ~${expect}` };
  }
  return {
    verdict: ratio >= lo && ratio <= hi ? 'PASS' : 'FAIL',
    ratio,
    expect,
    band: [lo, hi],
    reason: ratio >= lo && ratio <= hi ? undefined
      : `ratio ${ratio.toFixed(2)} outside ${lo.toFixed(2)}..${hi.toFixed(2)} (expected ~${expect})`,
  };
}
