# DualRate — an on-chain rate only when two independent providers agree

A reusable GenLayer Intelligent Contract primitive. No frontend, no
logo, no app — just the contract, its mechanism, and its evidence.

**Contract:** https://explorer-studio.genlayer.com/address/0xE72AeB60b7B5DbF8c7bbfF6d15C77C6a32DE1E1A
**Repo:** https://github.com/xiaoyu7799/dualrate-genlayer

## Problem

A single price feed can be wrong, stale, or manipulated. A builder who
needs an on-chain exchange rate — for a quote, a settlement reference,
a displayed conversion — should not have to trust one server's number.
DualRate stores a rate only when two independent providers agree on it,
and the agreement itself is produced by GenLayer validator consensus.

## Mechanism (summary)

- `request_rate(base, quote)` — base and quote are each exactly three
  uppercase A-Z characters, base != quote. Nothing else about the pair
  is validated; availability is proven (or not) by the verification.
- `verify_rate(id)` — the leader and every validator independently
  fetch the pair from both providers:
  - A: `https://api.exchangerate-api.com/v4/latest/{BASE}`
  - B: `https://api.frankfurter.dev/v1/latest?base={BASE}&symbols={QUOTE}`
- A validator accepts only if: the base/quote echo the request, the
  source URLs match the expected templates exactly, EACH leader rate is
  within `max(0.001, 1%)` of the validator's own rate for that source
  (integer arithmetic on rates scaled by 1,000,000), and the two leader
  rates agree with each other within 1.5% of their mean
  (`abs(A-B)*200 <= 3*(A+B)`).
- The two sources' dates are NOT required to be equal — providers
  update on different days. Dates are stored for transparency only.
- After consensus, the agreed rate is the integer mean of the two
  scaled rates, stored as a 6-decimal string. An agreed record cannot
  be re-verified. If either source fails, nothing is written and the
  record stays pending and retryable.

Full design: [`docs/mechanism.md`](docs/mechanism.md).

## Deployed contract (Stable Studionet only)

- **Network:** chain ID 61999, RPC https://studio.genlayer.com/api.
  Gasless, zero cost, no real funds.
- **Address:** `0xE72AeB60b7B5DbF8c7bbfF6d15C77C6a32DE1E1A`
- **Deploy tx:** `0x579080815c2522f2310e248362ada2e0cc78c180205a7712e3b133fe643a360a` (FINALIZED)
- **Deployer:** `0xCBF719038DA0513B3198c8aC3F372bc72D211039` (ephemeral)
- **File:** [`contracts/dualrate.py`](contracts/dualrate.py)
- **Writes:** `request_rate(base, quote) -> u256`, `verify_rate(id) -> str`
- **Views:** `get_rate(id)`, `get_count()`, `list_rates(offset, limit 1–20)`
- **Storage:** `rates: TreeMap[u256, str]` (JSON records),
  `ids: DynArray[u256]`, `next_id: u256`

## Verified on-chain flow (see [`evidence.json`](evidence.json))

- **Request tx:** `0x5e326dcb073aae61c07760482aede9baf7c1823a1dad9d27e52be86878ede114` (FINALIZED)
- **Verify tx:** `0x6a35c69da85bad0482452410a8352e721434b01e80eead992e95005b17e09a3e` (FINALIZED)
- **Record #0 read back, verbatim key fields:**
  - `base`: `USD`, `quote`: `EUR`
  - `status`: `agreed`
  - `agreed_rate`: `0.895545`
  - `rate_a`: `0.896000` (source A, date `2026-10-31`)
  - `rate_b`: `0.895090` (source B, date `2026-10-30`)
  - `source_a`: `https://api.exchangerate-api.com/v4/latest/USD`
  - `source_b`: `https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR`

## Simulation vs. on-chain evidence — do not confuse them

- `node scripts/simulate.mjs` runs **off-chain only**: it fetches both
  live providers twice in Node and applies the exact same integer
  tolerance and cross-source logic. On 2026-10-31 it printed
  `SIMULATION: PASS` (A = 0.896 dated 2026-10-31, B = 0.89509 dated
  2026-10-30, gap 0.1016%, mean 0.895545). This proves the tolerance
  logic is satisfiable against today's feeds. It is **not** consensus
  evidence and is never presented as such.
- The **consensus evidence** is the on-chain verify transaction above:
  real validators independently re-fetched both sources and accepted
  under the contract's rules, and the agreed record reads back from
  the contract. Only that counts.

## Use it from genlayer-js (1.1.8)

```js
import { createClient, createAccount } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";

const ADDRESS = "0xE72AeB60b7B5DbF8c7bbfF6d15C77C6a32DE1E1A";
const client = createClient({ chain: studionet, account });

// Request a rate (any account may call; the contract is permissionless)
const requestTx = await client.writeContract({
  address: ADDRESS, functionName: "request_rate",
  args: ["USD", "EUR"], value: 0n, leaderOnly: false,
});
await client.waitForTransactionReceipt({
  hash: requestTx, status: TransactionStatus.FINALIZED,
  retries: 180, interval: 5000,
});

// Verify it: validators fetch both providers and must agree
const id = Number(await client.readContract({
  address: ADDRESS, functionName: "get_count", args: [],
})) - 1;
const verifyTx = await client.writeContract({
  address: ADDRESS, functionName: "verify_rate",
  args: [BigInt(id)], value: 0n, leaderOnly: false,
});
await client.waitForTransactionReceipt({
  hash: verifyTx, status: TransactionStatus.FINALIZED,
  retries: 180, interval: 5000,
});

// Read the agreed record back
const record = JSON.parse(await client.readContract({
  address: ADDRESS, functionName: "get_rate", args: [BigInt(id)],
}));
console.log(record.status, record.agreed_rate); // "agreed" "0.895545"
```

## Run the scripts

```bash
npm install
node scripts/simulate.mjs  # off-chain only, no txs
node scripts/deploy.mjs    # writes deployment.json (key never written to disk)
node scripts/flow.mjs      # request + verify + read-back, writes evidence.json
```

Both deploy and flow accept `GENLAYER_PRIVATE_KEY`; if omitted, an
ephemeral key is generated for that run only (Studionet is gasless and
the contract is permissionless, so losing that key loses nothing).

## Repository layout

- `contracts/dualrate.py` — the Intelligent Contract
- `scripts/simulate.mjs`, `scripts/deploy.mjs`, `scripts/flow.mjs`
- `docs/mechanism.md` — full consensus design
- `docs/submission.md` — Intelligent Contracts submission copy
- `deployment.json`, `evidence.json` — on-chain proof (no keys inside)

## Honest limits

- Both providers must publish the pair. Frankfurter covers ECB
  reference currencies; a pair either provider does not publish fails
  verification and stays pending — by design, the contract never falls
  back to a single source.
- Both sources publish daily reference rates, not live ticks. The
  agreed rate is a consensus reference rate, not an executable market
  price.
- The free exchangerate-api v4 endpoint and frankfurter.dev carry no
  SLA and may rate-limit, change, or disappear. If either is down,
  verification waits.
- The 1.5% cross-source band detects disagreement; it does not prove
  market accuracy, and a pair of providers that are both wrong in the
  same direction would still agree.
- Rates are stored to 6 decimals; sub-micro-unit precision is lost in
  the integer mean (at most 0.0000005 per record).
