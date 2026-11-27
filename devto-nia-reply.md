---
title: "Reply to Nia: what happens when the M-Pesa callback is slow?"
published: false
tags: bitcoin, lightning, mpesa, opensource
series: Bitcoin to M-Pesa off-ramp
---

Nia asked exactly the right question on my off-ramp thread:

> Nice use of hold invoices. What happens when the M-Pesa result callback is slow? Long holds tie up liquidity along the route, so curious what timeout you picked before refunding.

Short answer: after 60 seconds with no callback I ask M-Pesa for the payout's status. I only refund on a final failure answer — never on a blind timer. That choice protects funds but it does tie up route liquidity, so here is the full trade-off, the code, and what I still need to fix.

Code: [altradits/offramp](https://github.com/altradits/offramp) (MIT). All paths below are in that repo.

## The timeline

```
t=0s    sats lock (ACCEPTED) -> we send B2C payout, journal PAYING first
t=0-60s normal: result callback arrives -> settle (PAID) or cancel (REFUNDED)
t=60s   no callback yet -> TransactionStatusQuery (same OriginatorConversationID)
        -> status answer arrives on /daraja/status
        -> Completed => settle | Failed/Cancelled/Expired => cancel
        -> still processing / no answer => ask again later
anytime LND cancels the hold first, then M-Pesa reports success
        -> settle fails -> NEEDS_REVIEW (shillings left, sats unclaimable)
```

The three numbers that control this are defaults in `createOfframp` ([src/offramp.mjs](https://github.com/altradits/offramp/blob/main/src/offramp.mjs)):

```js
cltvExpiry = 144, invoiceExpirySec = 600, statusAfterMs = 60_000
```

- `statusAfterMs = 60_000`: wait 60s in `PAYING` before the first status query.
- `invoiceExpirySec = 600`: the hold invoice expires for *new* payments after 10 minutes.
- `cltvExpiry = 144`: the HTLC safety margin (~24h of blocks).

## What the code actually does

The watchdog lives in the tick loop. Every tick also re-checks the invoice on LND, so a hold cancelled mid-payout is recorded before the M-Pesa answer even arrives — and an LND outage never skips a due status query:

```js
} else if (o.state === "PAYING") {
  const stale = Date.now() - Date.parse(o.updatedAt) > statusAfterMs && !o.asked;
  let inv = null;
  try {
    inv = await lnd.lookup(o.hashHex);
  } catch (e) { log(`[${o.id.slice(0, 8)}] ${e.message}`); } // LND down must not skip a due status query
  if (inv?.state === "CANCELED" && o.lndState !== "CANCELED") {
    save(o, { lndState: "CANCELED", why: "LND cancelled the invoice while the M-Pesa payout is in flight." });
  }
  if (stale) {
    o.asked = true;
    await daraja.status({ originatorId: o.id });
    log(`[${o.id.slice(0, 8)}] no result yet: asked M-Pesa for the payout's status`);
  }
}
```

`o.id` is reused as `OriginatorConversationID`, so the query refers to the exact payout and a retry can never become a second payment. `PAYING` is journaled *before* the B2C request is sent, so a crash in the middle restarts as `PAYING` and asks instead of re-paying. That is the "killed the server mid-payout" test: paid exactly once, receipt recovered.

The status query itself is Daraja's `TransactionStatusQuery` ([src/daraja.mjs](https://github.com/altradits/offramp/blob/main/src/daraja.mjs)). The answer arrives later on a different callback URL and in a different shape — the payout's ID is buried inside `ResultParameters` — so `parseResult` reads both shapes:

```js
final: Number(r.ResultCode) === 0 &&
  ["Completed", "Failed", "Cancelled", "Expired"].includes(params.TransactionStatus),
```

And the result handler only finishes on a final answer. Every LND call is followed by a lookup fallback, so a failure is recorded instead of thrown — and two callbacks racing for one order apply exactly once:

```js
const finalizePaid = () => {
  if (!["PAYING", "LOCKED"].includes(o.state)) return; // a racing callback already finalized
  save(o, { state: "PAID", receipt: r.receipt || o.receipt });
  if (r.utilityFunds === undefined) saveFloat(float - o.kes);
};
if (r.ok) {
  try {
    await lnd.settle(o.preimageHex);
  } catch (e) {
    const inv = await lnd.lookup(o.hashHex).catch(() => null);
    if (inv?.state === "SETTLED") { finalizePaid(); return; } // a racing callback settled it
    if (r.utilityFunds === undefined) saveFloat(float - o.kes);
    save(o, { state: "NEEDS_REVIEW", receipt: r.receipt || o.receipt, why: `M-Pesa paid but LND settle failed: ${e.message}` });
    return;
  }
  finalizePaid();
} else if (r.final) {
  ... same shape around lnd.cancel ...   // REFUNDED, or NEEDS_REVIEW if sats still locked
} else {
  o.asked = false; // not final yet (e.g. still processing): ask again later
}
```

`NEEDS_REVIEW` is the answer to the hardest follow-up I got after posting this: M-Pesa success arriving *after* LND cancelled the hold. The shillings left but the sats can't be claimed, so the order parks with the receipt and the reason where the operator can see it (`GET /order/:id`, logs, journal) instead of sticking in `PAYING` forever. I verified that exact sequence on the private regtest network: 18,820 sats locked, hold cancelled LND-side, mock M-Pesa paid KES 1,500, late success arrived two minutes later → `NEEDS_REVIEW` with receipt, payer's sats returned.

## Why 60 seconds, and why no blind refund

Daraja's own docs treat B2C as async: the `POST` only means "accepted", the money moves later, and the result/timeout callbacks can lag under load. 60s is long enough to avoid spamming status queries on every normal payout (my lab payouts confirm in ~1-3s) and short enough that a genuinely lost callback is chased while the customer is still watching.

The harder part of Nia's question: there is **no timer that cancels the hold invoice just because M-Pesa is quiet**. That is deliberate, and it is also the weakest point of the current code:

- If I refund after N minutes while M-Pesa later completes the payout, I lose the KES *and* return the sats. Double loss.
- So today the hold stays open until M-Pesa gives a final answer, or the invoice/CLTV expiry forces the issue. Once the invoice is `ACCEPTED`, the 600s invoice expiry stops new payments but the locked HTLC lives until settle/cancel or the CLTV branch — up to ~144 blocks in the worst case.

Nia is right that this ties up liquidity along the whole route for the duration. For a small, slow lane (one payout every few minutes) that is tolerable. For real volume it is not.

## What I am changing next

1. ~~**Bounded hold with status-gated cancel.**~~ Done: a final `Failed`/`Cancelled`/`Expired` status answer cancels immediately, including when LND already cancelled first (verified as refunded via lookup).
2. **Shorter, staggered queries.** One query at 60s, then backoff (e.g. 60s / 5min / 15min) instead of asking again on the very next tick after a non-final answer. Still open.
3. **Operator surface.** Partly done: `NEEDS_REVIEW` with receipt and reason, plus mid-payout LND cancels recorded on the order. Still missing: a resolve action once the operator investigates ([issue #19](https://github.com/altradits/offramp/issues/19)).
4. **Lower `cltvExpiry` for small payouts.** 144 is the LND-ish default; small tickets can carry a smaller worst-case lock. Still open.

If you run routing nodes: what worst-case hold would you tolerate from a service like this before you start failing its routes? I want the next timeout value to come from operators, not from me guessing.

## Try it yourself

```sh
git clone https://github.com/altradits/offramp.git
cd offramp
npm test   # 20 tests: paid, refused, crash-mid-payout, overlapping ticks, forged callbacks,
           # late success after LND cancel, racing callbacks, retries, daily limits
```

Then the full lab with real Lightning on regtest is in the README. Issues labelled `good first issue` / `help wanted` are open — MTN MoMo, Airtel Money, Vodacom M-Pesa and Telebirr adapters all have the same `pay` / `status` / `parseResult` shape.

Thank you Nia — this is exactly the review open source is for. 🧡
