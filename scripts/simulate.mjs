/* DualRate local simulation — simulation only, NOT consensus evidence.
 *
 * This script runs entirely off-chain in Node. It fetches both live
 * providers for USD/EUR twice (first fetch = "leader", second fetch =
 * "validator") and applies the EXACT same integer checks as
 * contracts/dualrate.py: per-source tolerance
 * abs diff <= max(1000 scaled units, 1% of validator's scaled rate), and
 * cross-source equivalence abs(A-B)*200 <= 3*(A+B) on the leader rates.
 * It proves the tolerance logic is satisfiable against today's live
 * feeds. It proves NOTHING about GenLayer consensus: only the on-chain
 * verify_rate transaction, with real validators, is consensus evidence.
 * No on-chain transaction is sent by this script.
 *
 * Usage: node scripts/simulate.mjs
 */
const SCALE = 1_000_000;
const BASE = "USD";
const QUOTE = "EUR";
const URL_A = `https://api.exchangerate-api.com/v4/latest/${BASE}`;
const URL_B = `https://api.frankfurter.dev/v1/latest?base=${BASE}&symbols=${QUOTE}`;

async function fetchBoth(tag) {
  const out = {};
  for (const [label, url] of [["a", URL_A], ["b", URL_B]]) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`source_${label} HTTP ${res.status}`);
    const data = await res.json();
    const raw = data?.rates?.[QUOTE];
    if (typeof raw !== "number" || !(raw > 0)) throw new Error(`source_${label} missing rate`);
    out[`rate_${label}_scaled`] = Math.round(raw * SCALE);
    out[`date_${label}`] = data.date;
    out[`rate_${label}`] = raw;
  }
  console.log(`${tag}: A=${out.rate_a} (date ${out.date_a})  B=${out.rate_b} (date ${out.date_b})`);
  return out;
}

function perSourceOk(leader, own) {
  for (const label of ["a", "b"]) {
    const tol = Math.max(1000, Math.floor(own[`rate_${label}_scaled`] / 100));
    const diff = Math.abs(leader[`rate_${label}_scaled`] - own[`rate_${label}_scaled`]);
    console.log(`per-source ${label}: leader=${leader[`rate_${label}_scaled`]} own=${own[`rate_${label}_scaled`]} diff=${diff} tol=${tol} -> ${diff <= tol ? "OK" : "FAIL"}`);
    if (diff > tol) return false;
  }
  return true;
}

const leader = await fetchBoth("leader  ");
const validator = await fetchBoth("validator");
const crossLhs = Math.abs(leader.rate_a_scaled - leader.rate_b_scaled) * 200;
const crossRhs = 3 * (leader.rate_a_scaled + leader.rate_b_scaled);
const crossOk = crossLhs <= crossRhs;
const gapPct = ((Math.abs(leader.rate_a_scaled - leader.rate_b_scaled) / ((leader.rate_a_scaled + leader.rate_b_scaled) / 2)) * 100).toFixed(4);
console.log(`cross-source: |A-B|*200=${crossLhs} <= 3*(A+B)=${crossRhs} -> ${crossOk ? "OK" : "FAIL"} (gap ${gapPct}%, limit 1.5%)`);
const agreedScaled = Math.floor((leader.rate_a_scaled + leader.rate_b_scaled) / 2);
console.log(`agreed mean (scaled): ${agreedScaled} -> ${(agreedScaled / SCALE).toFixed(6)}`);
const pass = perSourceOk(leader, validator) && crossOk;
console.log(pass ? "SIMULATION: PASS" : "SIMULATION: FAIL");
process.exit(pass ? 0 : 1);
