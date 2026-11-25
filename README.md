# offramp

A Lightning to mobile money off-ramp you can run yourself. Someone pays a Lightning invoice from any wallet; a phone number receives shillings on M-Pesa. If the M-Pesa payout fails, the Lightning payment is cancelled and the sats go back to the payer automatically.

This is the reference code for the article **"Her sats couldn't pay for dinner: build a Bitcoin to M-Pesa off-ramp that doesn't depend on one company"** on [dev.to/altradits](https://dev.to/altradits). The article explains every decision; this README is the short version.

> Status: reference implementation, tested on a private regtest network and against a local stand-in for Safaricom's Daraja API. It has not paid a real shilling. Running it for the public needs a Safaricom B2C account and, in Kenya, a licence under the Virtual Asset Service Providers Act 2025. Read "Before production" below.

## How it works

```
customer wallet          off-ramp (this code)              LND             M-Pesa (Daraja B2C)
     |  POST /quote {phone, kes} ->|                           |                    |
     |                             |-- add HOLD invoice ------->|                    |
     |<-- invoice (sats, rate) ----|                           |                    |
     |-- pays invoice --------------------------------------->| ACCEPTED (locked)  |
     |                             |<-- lookup: ACCEPTED ------|                    |
     |                             |-- journal: PAYING ---------------------------->| pay KES
     |                             |<------------------------- result callback -----|
     |                             |   ResultCode 0 -> settle(preimage): we get the sats
     |                             |   failure      -> cancel: the sats go back
     |<-- receipt (M-Pesa code) ---|                           |                    |
```

- `src/rate.mjs`: BTC/KES as the median of three exchanges times the median of two FX feeds. Refuses to quote if sources are missing or disagree by more than 2%.
- `src/lnd.mjs`: hold invoices over LND REST, with the **invoice macaroon** only (it cannot send money).
- `src/daraja.mjs`: M-Pesa B2C payout, transaction status query, and a parser for both result shapes.
- `src/offramp.mjs`: the state machine `INVOICED -> LOCKED -> PAYING -> PAID | REFUNDED | EXPIRED`, plus `NEEDS_REVIEW` when M-Pesa paid but the sats can't be claimed (LND cancelled first), written to an append-only journal before every action, plus float and limit checks.
- `src/mock-daraja.mjs`: a local stand-in for Daraja built from Safaricom's documented request and callback shapes. It verifies the OAuth token and decrypts the RSA-encrypted initiator password like the real API. **Never** point production at it.

## Run the tests (no node needed)

```sh
npm test
```

Thirteen tests: phone and amount validation, median pricing, rounding, a paid payout, a refused payout that refunds, float reservation, forged callbacks, overlapping ticks that must send one payout, a crash in the middle of a payout that must not pay twice, a late M-Pesa success after LND cancelled that parks the order for review, an LND cancel while locked that expires without paying, and an LND cancel mid-payout that is recorded without a second payout.

## Run the full lab (real Lightning, private network)

Needs `bitcoind` and an `lnd` built with the `invoicesrpc` tag (official release binaries include it).

```sh
zsh lab/up.sh                      # bitcoind regtest + two LND nodes: "wallet" and "svc"
source lab/env.sh                  # bcli, wal, svc helpers
# fund "wallet", open a channel wallet -> svc (see the article, step 2)
node lab/mock-run.mjs &            # MODE=ok | nofloat | silent
NO_MOCK=1 node lab/run.mjs &       # the off-ramp on :7080
zsh lab/scenario.sh x 1500         # quote KES 1,500, pay it from "wallet", print the outcome
```

## Before production

1. A B2C-enabled shortcode (Bulk Disbursement Account, or a paybill/till converted to "one account"), production Daraja credentials, and Safaricom's production certificate.
2. HTTPS callbacks on a secret path, restricted to Safaricom's published callback IPs. Answer within seconds.
3. Keep the journal on durable storage and protect it: it holds the preimages, which are the right to claim each payment.
4. Funded float in the B2C utility account, and a plan to refill it (selling the sats you receive).
5. Legal: in Kenya the Virtual Asset Service Providers Act 2025 and its 2026 regulations apply to anyone exchanging bitcoin for shillings for the public. Get advice before you take a single customer.

## Contributing

Open issues are labelled `good first issue` and `help wanted`. The biggest ones:

- Other countries: MTN MoMo, Airtel Money, Vodacom M-Pesa (Tanzania, DRC, Mozambique), Telebirr. Each is one payout adapter with the same `pay` / `status` / `parseResult` shape.
- The person-to-person agent mode: a hold invoice whose preimage the customer holds until their M-Pesa SMS arrives, so an agent with a phone can be the off-ramp when no business is available.
- Core Lightning and LDK Node backends next to LND.
- A Postgres or SQLite journal next to the file journal.

Keep changes small, tested, and free of secrets. One issue per change.

## License

MIT
