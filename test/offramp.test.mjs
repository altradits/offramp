// The off-ramp's rules, tested without a Lightning node: an in-memory LND
// stands in for hold invoices, the mock M-Pesa for Daraja.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { createOfframp, normalisePhone } from "../src/offramp.mjs";
import { darajaClient, parseResult } from "../src/daraja.mjs";
import { mockDaraja } from "../src/mock-daraja.mjs";
import { satsFor, median } from "../src/rate.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "offramp-"));
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", `${dir}/k.key`, "-out", `${dir}/k.cer`, "-days", "1", "-subj", "/CN=t"], { stdio: "ignore" });

function fakeLnd() {
  const inv = new Map();
  return {
    inv,
    addHold: async ({ hashHex, sats }) => { inv.set(hashHex, { state: "OPEN", sats }); return { payment_request: "lnbcrt" + hashHex.slice(0, 10) }; },
    lookup: async (h) => inv.get(h),
    settle: async (pre) => { const h = crypto.createHash("sha256").update(Buffer.from(pre, "hex")).digest("hex"); inv.get(h).state = "SETTLED"; },
    cancel: async (h) => { inv.get(h).state = "CANCELED"; },
    pay: (h) => { inv.get(h).state = "ACCEPTED"; }, // the customer's wallet pays
  };
}

let port = 7170;
async function setup({ mode = "ok", float = 20_000, statusAfterMs = 60_000 } = {}) {
  const p = port++; const cb = port++;
  let m = mode;
  const mock = mockDaraja({ port: p, key: "k", secret: "s", initiator: "i", password: "pw#1", privateKeyPath: `${dir}/k.key`, utility: float, mode: () => m, delayMs: 50 });
  const lnd = fakeLnd();
  const journalPath = `${dir}/j-${cb}.jsonl`;
  const make = () => createOfframp({ lnd, journalPath, floatKes: float, statusAfterMs, log: () => {},
    rate: async () => ({ btcKes: 8_000_000 }),
    daraja: darajaClient({ baseUrl: `http://127.0.0.1:${p}`, consumerKey: "k", consumerSecret: "s", initiator: "i", initiatorPassword: "pw#1",
      certPath: `${dir}/k.cer`, shortcode: "600000", resultUrl: `http://127.0.0.1:${cb}/daraja/result`, statusUrl: `http://127.0.0.1:${cb}/daraja/status`, timeoutUrl: `http://127.0.0.1:${cb}/daraja/timeout` }) });
  const off = make();
  off.server.listen(cb, "127.0.0.1");
  after(() => { mock.server.close(); off.server.close(); });
  return { off, lnd, mock, make, cb, setMode: (x) => { m = x; } };
}
const until = async (f, ms = 3000) => { const t = Date.now(); while (!(await f())) { if (Date.now() - t > ms) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 20)); } };

test("phone numbers: local and international forms, nothing else", () => {
  assert.equal(normalisePhone("0712 345 678"), "254712345678");
  assert.equal(normalisePhone("+254 110 123 456"), "254110123456");
  assert.equal(normalisePhone("020 123 4567"), null);
  assert.equal(normalisePhone("0712345"), null);
});

test("price: median ignores one wild source, sats round up, fee on top", () => {
  assert.equal(median([61_900, 61_950, 90_000]), 61_950);
  assert.equal(satsFor(1500, 8_050_119, 1), 18_820);
  assert.equal(satsFor(10, 8_000_000, 0), 125);
});

test("paid: M-Pesa pays, then the invoice settles with the receipt", async () => {
  const { off, lnd, mock } = await setup();
  const q = await off.quote({ phone: "0712345678", kes: 1500 });
  assert.equal(q.sats, satsFor(1500, 8_000_000, 1));
  const o = off.orders.get(q.id);
  lnd.pay(o.hashHex); await off.tick();
  await until(() => o.state === "PAID");
  assert.equal(lnd.inv.get(o.hashHex).state, "SETTLED");
  assert.match(o.receipt, /^T[0-9A-F]{9}$/);
  assert.equal(mock.balance(), 18_500);
});

test("refused: a failed payout cancels the invoice, so the customer keeps the sats", async () => {
  const { off, lnd } = await setup({ mode: "nofloat" });
  const o = off.orders.get((await off.quote({ phone: "0712345678", kes: 2000 })).id);
  lnd.pay(o.hashHex); await off.tick();
  await until(() => o.state === "REFUNDED");
  assert.equal(lnd.inv.get(o.hashHex).state, "CANCELED");
});

test("no quote beyond the float, including what open orders already reserve", async () => {
  const { off } = await setup({ float: 5000 });
  await off.quote({ phone: "0712345678", kes: 4000 });
  await assert.rejects(off.quote({ phone: "0722345678", kes: 1500 }), /Not enough shillings/);
});

test("amounts: whole shillings only, as numbers, within the limits", async () => {
  const { off } = await setup();
  for (const kes of ["500", 9, 50_001, 10.5]) await assert.rejects(off.quote({ phone: "0712345678", kes }), /whole number/);
});

test("forged callbacks are ignored unless the order is waiting for M-Pesa", async () => {
  const { off, lnd } = await setup();
  const o = off.orders.get((await off.quote({ phone: "0712345678", kes: 100 })).id);
  await off.onResult({ Result: { ResultCode: 0, OriginatorConversationID: o.id, TransactionID: "FAKE" } });
  assert.equal(o.state, "INVOICED"); // not paid by the customer yet: nothing to settle
  assert.equal(lnd.inv.get(o.hashHex).state, "OPEN");
});

test("crash while paying: a restart asks M-Pesa instead of paying twice", async () => {
  const { off, lnd, mock, make, cb, setMode } = await setup({ mode: "silent", statusAfterMs: 50 });
  const o = off.orders.get((await off.quote({ phone: "0712345678", kes: 3000 })).id);
  lnd.pay(o.hashHex); await off.tick();
  await until(() => mock.balance() === 17_000); // M-Pesa paid, but its callback never came
  await new Promise((r) => off.server.close(r)); // the process dies
  const again = make(); // a fresh process reading the same journal
  await new Promise((r) => again.server.listen(cb, "127.0.0.1", r));
  setMode("ok");
  const o2 = again.orders.get(o.id);
  assert.equal(o2.state, "PAYING");
  await new Promise((r) => setTimeout(r, 80));
  await again.tick(); // asks M-Pesa for the status; the answer arrives on the callback
  await until(() => o2.state === "PAID");
  assert.match(o2.receipt, /^T[0-9A-F]{9}$/);
  assert.equal(lnd.inv.get(o.hashHex).state, "SETTLED");
  assert.equal(mock.balance(), 17_000); // paid exactly once
  again.server.close();
});

test("overlapping ticks with a slow LND pay M-Pesa once", async () => {
  const { off, lnd, mock } = await setup();
  const o = off.orders.get((await off.quote({ phone: "0712345678", kes: 700 })).id);
  lnd.pay(o.hashHex);
  const fast = lnd.lookup;
  lnd.lookup = async (h) => { await new Promise((r) => setTimeout(r, 100)); return fast(h); };
  await Promise.all([off.tick(), off.tick(), off.tick()]); // what setInterval does when a tick runs long
  await until(() => o.state === "PAID");
  assert.equal(mock.payRequests(), 1); // one request sent, not one per tick
  assert.equal(mock.balance(), 20_000 - 700);
});

test("status answers are read from inside ResultParameters", () => {
  const r = parseResult({ Result: { ResultCode: 0, OriginatorConversationID: "the-query", ResultParameters: { ResultParameter: [
    { Key: "OriginatorConversationID", Value: "the-payout" }, { Key: "TransactionStatus", Value: "Completed" }, { Key: "ReceiptNo", Value: "R1" } ] } } });
  assert.equal(r.originatorId, "the-payout");
  assert.equal(r.ok, true);
});
