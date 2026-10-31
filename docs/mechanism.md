# DualRate mechanism

## Goal

Give other builders a primitive they can reuse wherever an on-chain
number must not come from a single server: a foreign-exchange rate
that is stored only when two independent providers agree, under
validator consensus, with the agreement rule stated in arithmetic
that anyone can re-check.

## State

- `rates: TreeMap[u256, str]` — one JSON record per rate request.
- `ids: DynArray[u256]` — request order.
- `next_id: u256` — next id, starting at 0.

A record:

```json
{
  "id": 0,
  "base": "USD",
  "quote": "EUR",
  "requester": "0x…",
  "status": "pending",
  "agreed_rate": null,
  "rate_a": null,
  "rate_b": null,
  "date_a": null,
  "date_b": null,
  "source_a": "https://api.exchangerate-api.com/v4/latest/USD",
  "source_b": "https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR"
}
```

After verification, `status` becomes `"agreed"` and the `rate_*` /
`date_*` fields are filled. Nothing else ever mutates a record.

## Request validation (deterministic, `request_rate`)

- Each code must be exactly 3 characters, each A–Z. Anything else
  (lowercase, digits, wrong length) is rejected with a UserError.
- Base must differ from quote.
- No validation of whether the pair exists at either provider. That is
  deliberately left to verification: a request for an unpublished pair
  is cheap to make and simply never verifies, instead of the contract
  pretending to know each provider's currency universe.

## Verification (`verify_rate`, nondet + consensus)

The nondet function `fetch_both` runs for the leader and for every
validator, independently:

1. Fetch source A, then source B. A non-200 status, a network failure,
   bad JSON, a missing/non-positive rate, or a missing date raises a
   UserError immediately, before any write. The record stays
   `"pending"` and the verification can be retried later.
2. Each rate is converted to a scaled integer,
   `rate_scaled = int(round(rate * 1_000_000))`. Only strings and
   ints leave the nondet function. GenVM calldata cannot encode
   floats; returning a float crashes the leader with
   "not calldata encodable ...: float" even though the transaction
   itself finalizes.
3. The result carries the echoed base/quote, both source URLs, both
   scaled rates, and both source dates.

The `validate` function accepts the leader result only if:

1. **Echo:** `base` and `quote` equal the stored request.
2. **URL templates:** `url_a` and `url_b` equal the exact URLs stored
   at request time for this pair. A leader cannot substitute a
   different feed, a cached page, or its own server.
3. **Per-source tolerance (integer arithmetic):** for each source,
   `abs(leader_scaled - validator_scaled) <= max(1000, validator_scaled // 100)`.
   1000 scaled units = 0.001 absolute, which dominates for small rates;
   1% dominates for large rates. The tolerance is deliberately
   asymmetric-safe: it is anchored on the validator's own fresh fetch,
   never on the leader's number.
4. **Cross-source equivalence:** on the leader's two rates,
   `abs(A - B) * 200 <= 3 * (A + B)`, i.e. the two providers are within
   1.5% of their mean. This is the equivalence check that makes the
   primitive dual-source rather than two parallel single-source checks:
   even if each provider were stable over time, a pair that disagrees
   with itself by more than 1.5% cannot become an agreed rate.

If the leader raised a UserError, a validator agrees only if its own
fetch also fails with a UserError (the WeatherProof pattern): agreement
that the sources are unavailable is itself consensus that nothing can
be verified yet.

## Deterministic storage after consensus

`agreed_rate = (rate_a_scaled + rate_b_scaled) // 2`, formatted as a
6-decimal string (`scaled // 1_000_000` + zero-padded remainder).
Both source rates are stored the same way, with both source dates.
An already-agreed record raises `EXPECTED: rate_already_agreed` and is
never overwritten.

## Worked example (real, 2026-10-31, USD/EUR)

- Source A: 0.896, dated 2026-10-31 → scaled 896000.
- Source B: 0.89509, dated 2026-10-30 → scaled 895090.
- Cross-source gap: |896000 − 895090| × 200 = 182,000 ≤
  3 × (896000 + 895090) = 5,373,270 → pass (0.1016% of the mean).
- Agreed: (896000 + 895090) // 2 = 895545 → `"0.895545"`.
- Dates differ (2026-10-31 vs 2026-10-30) and that is fine: the rule
  never compares dates, only rates.

## What this primitive does not do

- It does not pick the "better" provider, average away a real
  disagreement, or trade. A disagreement beyond 1.5% blocks the rate.
- It does not prove a rate at a precise time of day. Both sources are
  daily reference rates; the agreed rate is dated by each provider's
  own publication date, stored alongside it.
- It does not authenticate the providers beyond their public HTTPS
  endpoints. A provider that publishes a wrong rate its validators
  also fetch will pass per-source tolerance — which is exactly why
  the cross-source check exists: the two providers would both have
  to be wrong in the same direction, by a similar amount, for a bad
  rate to be agreed.
