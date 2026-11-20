// Lab runner: mock M-Pesa on :7070, the off-ramp on :7080, ticking every second.
// MODE env: ok | nofloat | silent. FLOAT env: shillings in the payout account.
import { lndClient } from "../src/lnd.mjs";
import { darajaClient } from "../src/daraja.mjs";
import { mockDaraja } from "../src/mock-daraja.mjs";
import { createOfframp } from "../src/offramp.mjs";

const L = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const MODE = process.env.MODE || "ok";
const FLOAT = Number(process.env.FLOAT || 20000);
const creds = { key: "lab-key", secret: "lab-secret", initiator: "labapi", password: "Lab#2026" };

if (!process.env.NO_MOCK) mockDaraja({ port: 7070, ...creds, privateKeyPath: `${L}/keys/mock-daraja.key`, utility: FLOAT, mode: () => MODE });

const off = createOfframp({
  lnd: lndClient({ url: "https://127.0.0.1:8091", certPath: `${L}/svc/tls.cert`, macaroonPath: `${L}/svc/data/chain/bitcoin/regtest/invoice.macaroon` }),
  daraja: darajaClient({ baseUrl: "http://127.0.0.1:7070", consumerKey: creds.key, consumerSecret: creds.secret, initiator: creds.initiator,
    initiatorPassword: creds.password, certPath: `${L}/keys/mock-daraja.cer`, shortcode: "600000",
    resultUrl: "http://127.0.0.1:7080/daraja/result", statusUrl: "http://127.0.0.1:7080/daraja/status", timeoutUrl: "http://127.0.0.1:7080/daraja/timeout" }),
  // Today's live median (see rate.mjs), fixed for the lab so every run is comparable.
  rate: async () => ({ btcKes: Number(process.env.BTCKES || 8050119) }),
  journalPath: `${L}/journal.jsonl`,
  floatKes: FLOAT,
  statusAfterMs: Number(process.env.STATUS_AFTER_MS || 60000),
  log: (m) => console.log(new Date().toISOString().slice(11, 19), m),
});
off.server.listen(7080, "127.0.0.1");
setInterval(off.tick, 1000);
console.log(`off-ramp on :7080, mock M-Pesa mode=${MODE}, float KES ${FLOAT}`);
