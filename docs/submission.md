# DualRate — Intelligent Contracts submission copy

## Title

DualRate — a dual-source FX agreement primitive

## Description

DualRate is a reusable GenLayer Intelligent Contract primitive that
solves a concrete trust problem for builders: a single price feed can
be wrong, stale, or manipulated, yet most on-chain rates still come
from one server's number. DualRate stores an exchange rate only when
two independent providers agree on it, under validator consensus.

Anyone calls request_rate with a currency pair (for example USD/EUR).
Anyone can then call verify_rate: the leader and every validator
independently fetch the pair from exchangerate-api and frankfurter.dev
— both free and keyless — and the rate is stored only if each leader
rate is within max(0.001, 1%) of the validator's own rate for that
source, and the two leader rates agree with each other within 1.5% of
their mean. The agreed rate is the integer mean of the two scaled
rates, stored to six decimals together with both source rates, both
source dates, and both source URLs. If either source fails, nothing is
written and the record stays pending and retryable. There is no LLM
anywhere in the contract: an FX agreement check is arithmetic, and it
is checked arithmetically, with rates carried as scaled integers
because GenVM calldata cannot encode floats.

DualRate is designed to be reused: any builder that needs a
consensus-backed reference rate can call it, read it, or fork the
single contract file, without a frontend, a server, or an API key.

## How consensus is used

Consensus is the product, not a decoration. The leader's fetch alone
stores nothing: every validator independently re-fetches BOTH sources
and rejects the result unless its own rates match the leader's within
the per-source tolerance and the leader's two rates satisfy the
cross-source equivalence check. The two sources' dates are deliberately
not required to match, because providers update on different days;
agreement is about rates, and dates are stored for transparency. The
agreed rate is then computed deterministically from the agreed inputs,
and an agreed record can never be re-verified or overwritten.

## Verified on-chain evidence

- Contract: https://explorer-studio.genlayer.com/address/0xE72AeB60b7B5DbF8c7bbfF6d15C77C6a32DE1E1A
- Deploy tx: 0x579080815c2522f2310e248362ada2e0cc78c180205a7712e3b133fe643a360a (FINALIZED)
- Request tx (USD/EUR): 0x5e326dcb073aae61c07760482aede9baf7c1823a1dad9d27e52be86878ede114 (FINALIZED)
- Verify tx: 0x6a35c69da85bad0482452410a8352e721434b01e80eead992e95005b17e09a3e (FINALIZED)
- Record #0 read back: status "agreed", agreed_rate "0.895545",
  rate_a "0.896000" (dated 2026-10-31), rate_b "0.895090" (dated
  2026-10-30)

## Links

- GitHub: https://github.com/xiaoyu7799/dualrate-genlayer
- Contract: https://explorer-studio.genlayer.com/address/0xE72AeB60b7B5DbF8c7bbfF6d15C77C6a32DE1E1A
- Evidence: https://github.com/xiaoyu7799/dualrate-genlayer/blob/main/evidence.json
- Source: https://github.com/xiaoyu7799/dualrate-genlayer/blob/main/contracts/dualrate.py
