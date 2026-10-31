# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
"""DualRate: a dual-source FX agreement primitive for GenLayer.

Problem
-------
A single price feed can be wrong, stale, or manipulated. Builders who
need an on-chain exchange rate — for a quote, a settlement reference, a
displayed conversion — should not have to trust one server's number.
What they need is a rate that two independent providers agree on, with
the agreement itself produced by validator consensus, not asserted by
any single party.

What this contract does
-----------------------
1. Anyone requests a rate: a base and a quote currency, each exactly
   three uppercase A-Z characters, base != quote (e.g. USD/EUR).
2. Anyone verifies it. The leader and every validator independently
   fetch the same pair from TWO free, keyless providers:
     A: https://api.exchangerate-api.com/v4/latest/{BASE}
        (JSON field rates[QUOTE], plus field date)
     B: https://api.frankfurter.dev/v1/latest?base={BASE}&symbols={QUOTE}
        (JSON field rates[QUOTE], plus field date)
3. Only if the validators agree — per-source tolerance AND cross-source
   equivalence, see below — is an agreed rate written on-chain, as the
   integer mean of the two providers' scaled rates, together with both
   source rates and both source dates.

Consensus design (the part that matters)
----------------------------------------
* The nondet function fetches BOTH sources. If either fetch fails,
  returns non-200, or is unparseable, it raises a UserError BEFORE any
  state is written, so the record stays "pending" and can be retried.
  A failed verification never writes a half-agreed rate.
* Rates are carried as scaled integers, never floats:
  rate_scaled = int(round(rate * 1_000_000)). GenVM calldata cannot
  encode floats — returning a float from a nondet function crashes the
  leader with "not calldata encodable ...: float" and leaves the record
  pending despite FINALIZED. Only strings and ints cross the
  nondet boundary here; the stored rates are 6-decimal strings
  formatted from the scaled integers after consensus.
* A validator accepts the leader result only if ALL of these hold:
    (1) the leader's base and quote echo the stored request exactly,
    (2) the leader's source URLs equal the two expected URL templates
        for that pair exactly,
    (3) EACH leader rate is within tolerance of the validator's own
        independently fetched rate for that same source:
        abs diff <= max(1000 scaled units (= 0.001), 1% of the
        validator's scaled rate), computed with integers,
    (4) the two leader rates agree with EACH OTHER (cross-source
        equivalence): abs(A - B) * 200 <= 3 * (A + B), i.e. within
        1.5% of their mean.
  Checking only one source, or only the shape of the leader output,
  would not be consensus, so the validator never accepts a result it
  did not independently reproduce for both sources.
* The two sources' dates are NOT required to be equal: providers update
  on different days (e.g. USD/EUR observed 2026-10-31: A = 0.896 dated
  2026-10-31 vs B = 0.89509 dated 2026-10-30, a 0.10% gap). Dates are
  stored for transparency only; agreement is about the rates.
* After consensus, the agreed rate is stored deterministically as the
  mean of the two leader scaled rates, formatted to 6 decimals
  (e.g. "0.895545"). An agreed record can never be re-verified.

Limits, stated honestly
-----------------------
* Both providers must support the pair. Frankfurter covers the ECB
  reference currencies; exchangerate-api v4 covers more, but a pair
  either provider does not publish fails verification and the record
  stays pending — the contract validates the code format only, never
  the pair's availability, by design.
* The agreed rate is a consensus reference rate, not a tradable or
  executable market price: it is a daily reference rate (both sources
  publish daily rates), not a live tick, and the 1.5% cross-source
  band is a disagreement detector, not a guarantee of market accuracy.
* Both sources are free endpoints with no SLA; either may rate-limit,
  change, or disappear. If either is down, verification waits — it
  does not fall back to a single source, because that would defeat
  the entire primitive.
* No LLM is involved anywhere in this contract, deliberately: an FX
  agreement check is arithmetic, and arithmetic should be checked
  arithmetically.
"""

import json

from genlayer import *

SCALE = 1000000


def _url_a(base: str) -> str:
    return f"https://api.exchangerate-api.com/v4/latest/{base}"


def _url_b(base: str, quote: str) -> str:
    return f"https://api.frankfurter.dev/v1/latest?base={base}&symbols={quote}"


def _format_scaled(scaled: int) -> str:
    return f"{scaled // SCALE}.{scaled % SCALE:06d}"


def _check_currency(code: str) -> str:
    if len(code) != 3:
        raise gl.vm.UserError("EXPECTED: currency_must_be_3_chars")
    for ch in code:
        if ch < "A" or ch > "Z":
            raise gl.vm.UserError("EXPECTED: currency_must_be_uppercase_AZ")
    return code


class DualRate(gl.Contract):
    rates: TreeMap[u256, str]
    ids: DynArray[u256]
    next_id: u256

    def __init__(self):
        self.next_id = u256(0)

    # -- deterministic helpers -------------------------------------------

    def _load(self, rate_id: u256) -> dict:
        if rate_id not in self.rates:
            raise gl.vm.UserError("EXPECTED: rate_not_found")
        return json.loads(self.rates[rate_id])

    # -- writes ------------------------------------------------------------

    @gl.public.write
    def request_rate(self, base: str, quote: str) -> u256:
        base = _check_currency(base)
        quote = _check_currency(quote)
        if base == quote:
            raise gl.vm.UserError("EXPECTED: base_must_differ_from_quote")
        rate_id = self.next_id
        self.next_id = rate_id + u256(1)
        record = {
            "id": int(rate_id),
            "base": base,
            "quote": quote,
            "requester": str(gl.message.sender_address),
            "status": "pending",
            "agreed_rate": None,
            "rate_a": None,
            "rate_b": None,
            "date_a": None,
            "date_b": None,
            "source_a": _url_a(base),
            "source_b": _url_b(base, quote),
        }
        self.rates[rate_id] = json.dumps(record)
        self.ids.append(rate_id)
        return rate_id

    @gl.public.write
    def verify_rate(self, rate_id: u256) -> str:
        record = self._load(rate_id)
        if record["status"] != "pending":
            raise gl.vm.UserError("EXPECTED: rate_already_agreed")
        base = record["base"]
        quote = record["quote"]
        url_a = record["source_a"]
        url_b = record["source_b"]

        def fetch_both() -> dict:
            out = {"base": base, "quote": quote, "url_a": url_a, "url_b": url_b}
            for label, url in (("a", url_a), ("b", url_b)):
                try:
                    response = gl.nondet.web.get(url)
                except Exception:
                    raise gl.vm.UserError(f"EXTERNAL: source_{label}_fetch_failed")
                if getattr(response, "status", 200) != 200:
                    raise gl.vm.UserError(
                        f"EXTERNAL: source_{label}_status_{getattr(response, 'status', '?')}"
                    )
                body = response.body
                if isinstance(body, bytes):
                    text = body.decode("utf-8")
                else:
                    text = str(body)
                try:
                    data = json.loads(text)
                except Exception:
                    raise gl.vm.UserError(f"EXTERNAL: source_{label}_bad_json")
                try:
                    rates = data["rates"]
                    raw = rates[quote]
                    value = float(raw)
                    if value <= 0:
                        raise ValueError("non-positive rate")
                    scaled = int(round(value * SCALE))
                except Exception:
                    raise gl.vm.UserError(f"EXTERNAL: source_{label}_missing_rate")
                date = data.get("date")
                if not isinstance(date, str):
                    raise gl.vm.UserError(f"EXTERNAL: source_{label}_missing_date")
                out[f"rate_{label}_scaled"] = scaled
                out[f"date_{label}"] = date
            return out

        def validate(leader_result) -> bool:
            if isinstance(leader_result, gl.vm.UserError):
                try:
                    fetch_both()
                except gl.vm.UserError:
                    return True
                except Exception:
                    return False
                return False
            if not isinstance(leader_result, gl.vm.Return):
                return False
            leader = leader_result.calldata
            if not isinstance(leader, dict):
                return False
            # (1) echo of the stored request
            if leader.get("base") != base or leader.get("quote") != quote:
                return False
            # (2) exact source URL templates
            if leader.get("url_a") != url_a or leader.get("url_b") != url_b:
                return False
            try:
                own = fetch_both()
            except Exception:
                return False
            try:
                leader_a = leader["rate_a_scaled"]
                leader_b = leader["rate_b_scaled"]
                own_a = own["rate_a_scaled"]
                own_b = own["rate_b_scaled"]
                if not all(isinstance(v, int) for v in (leader_a, leader_b, own_a, own_b)):
                    return False
            except Exception:
                return False
            # (3) per-source tolerance, integer arithmetic:
            # abs diff <= max(1000, 1% of validator's scaled rate)
            for leader_v, own_v in ((leader_a, own_a), (leader_b, own_b)):
                tol = own_v // 100
                if tol < 1000:
                    tol = 1000
                if abs(leader_v - own_v) > tol:
                    return False
            # (4) cross-source equivalence on the leader rates:
            # abs(A - B) * 200 <= 3 * (A + B)  (within 1.5% of the mean)
            if abs(leader_a - leader_b) * 200 > 3 * (leader_a + leader_b):
                return False
            return True

        result = gl.vm.run_nondet_unsafe(fetch_both, validate)
        agreed_scaled = (result["rate_a_scaled"] + result["rate_b_scaled"]) // 2
        record["status"] = "agreed"
        record["agreed_rate"] = _format_scaled(agreed_scaled)
        record["rate_a"] = _format_scaled(result["rate_a_scaled"])
        record["rate_b"] = _format_scaled(result["rate_b_scaled"])
        record["date_a"] = result["date_a"]
        record["date_b"] = result["date_b"]
        self.rates[rate_id] = json.dumps(record)
        return json.dumps(record)

    # -- views -------------------------------------------------------------

    @gl.public.view
    def get_rate(self, rate_id: u256) -> str:
        return json.dumps(self._load(rate_id))

    @gl.public.view
    def get_count(self) -> u256:
        return u256(len(self.ids))

    @gl.public.view
    def list_rates(self, offset: u256, limit: u256) -> str:
        if limit < 1 or limit > 20:
            raise gl.vm.UserError("EXPECTED: limit_must_be_1_to_20")
        total = len(self.ids)
        start = int(offset)
        if start >= total:
            return json.dumps([])
        end = start + int(limit)
        if end > total:
            end = total
        out = []
        index = start
        while index < end:
            out.append(json.loads(self.rates[self.ids[index]]))
            index += 1
        return json.dumps(out)
