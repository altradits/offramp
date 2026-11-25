// A Lightning -> M-Pesa off-ramp in one file.
//
//   1. POST /quote {phone, kes}  -> a price, and a HOLD invoice for the sats
//   2. the customer pays it      -> LND locks the sats (state ACCEPTED), we can't spend them yet
//   3. we pay KES by M-Pesa B2C  -> Safaricom calls back with a result
//   4. result OK   -> settle the invoice (we receive the sats), show the M-Pesa receipt
//      result FAIL -> cancel the invoice (the customer's sats go back to them)
//      paid but LND already cancelled -> NEEDS_REVIEW, the operator must look
//
// The customer is never charged for a payout that didn't happen, and we never
// pay out without the sats already locked in the channel.
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import { satsFor } from "./rate.mjs";
import { parseResult } from "./daraja.mjs";

// A Kenyan mobile number in international form (07xx / 01xx). Which network it
// is on can't be read from the prefix: numbers move between networks (number
// portability). M-Pesa itself refuses a number that has no M-Pesa account
// (ResultCode 2040), and that refusal refunds the customer like any other.
const KENYAN_MOBILE = /^254[17]\d{8}$/;

export function normalisePhone(raw) {
  let d = String(raw || "").replace(/[\s()+-]/g, "");
  if (/^0\d{9}$/.test(d)) d = "254" + d.slice(1);
  return KENYAN_MOBILE.test(d) ? d : null;
}

export function createOfframp({ lnd, daraja, rate, journalPath, feePct = 1, minKes = 10, maxKes = 50_000,
  dailyKesPerPhone = 100_000, floatKes, cltvExpiry = 144, invoiceExpirySec = 600, statusAfterMs = 60_000, log = console.log }) {
  const orders = new Map();
  let float = floatKes; // what the B2C utility account holds; corrected by every result callback

  // ---- the journal: every state change is appended before we act on it,
  // so a crash between "asked M-Pesa to pay" and "heard back" is recoverable.
  if (fs.existsSync(journalPath)) {
    for (const line of fs.readFileSync(journalPath, "utf8").split("\n").filter(Boolean)) {
      const e = JSON.parse(line);
      if (e.float !== undefined) float = e.float;
      if (e.id) orders.set(e.id, { ...(orders.get(e.id) || {}), ...e });
    }
  }
  const save = (o, change) => {
    Object.assign(o, change, { updatedAt: new Date().toISOString() });
    fs.appendFileSync(journalPath, JSON.stringify({ id: o.id, ...change, updatedAt: o.updatedAt }) + "\n");
    log(`[${o.id.slice(0, 8)}] ${o.state}${change.receipt ? " receipt " + change.receipt : ""}${change.why ? " (" + change.why + ")" : ""}`);
  };
  const saveFloat = (v) => { float = v; fs.appendFileSync(journalPath, JSON.stringify({ float: v }) + "\n"); };

  const open = (o) => ["INVOICED", "LOCKED", "PAYING"].includes(o.state);
  const reserved = () => [...orders.values()].filter(open).reduce((s, o) => s + o.kes, 0);
  const paidToday = (phone) => {
    const day = new Date().toISOString().slice(0, 10);
    return [...orders.values()].filter((o) => o.phone === phone && (open(o) || o.state === "PAID") && o.createdAt.startsWith(day))
      .reduce((s, o) => s + o.kes, 0);
  };

  async function quote({ phone: rawPhone, kes: rawKes }) {
    const phone = normalisePhone(rawPhone);
    const kes = rawKes;
    if (!phone) throw httpErr(400, "That is not a Kenyan mobile number.");
    if (typeof kes !== "number" || !Number.isInteger(kes) || kes < minKes || kes > maxKes) throw httpErr(400, `Amount must be a whole number of shillings from ${minKes} to ${maxKes}.`);
    if (paidToday(phone) + kes > dailyKesPerPhone) throw httpErr(429, "Daily limit for this number reached.");
    if (kes > float - reserved()) throw httpErr(503, "Not enough shillings in the payout account right now. Try a smaller amount or later.");

    const r = await rate();
    const sats = satsFor(kes, r.btcKes, feePct);
    const preimage = crypto.randomBytes(32);
    const hashHex = crypto.createHash("sha256").update(preimage).digest("hex");
    const id = crypto.randomUUID();
    const inv = await lnd.addHold({ hashHex, sats, memo: `KES ${kes} to M-Pesa ${phone.slice(0, 6)}***${phone.slice(-2)}`, expirySec: invoiceExpirySec, cltvExpiry });
    const o = { id };
    orders.set(id, o);
    save(o, { state: "INVOICED", phone, kes, sats, btcKes: r.btcKes, feePct, hashHex, preimageHex: preimage.toString("hex"),
      invoice: inv.payment_request, createdAt: new Date().toISOString() });
    return view(o);
  }

  const view = (o) => ({ id: o.id, state: o.state, kes: o.kes, sats: o.sats, rate: Math.round(o.btcKes), invoice: o.state === "INVOICED" ? o.invoice : undefined, receipt: o.receipt || null, why: (o.state === "NEEDS_REVIEW" || o.lndState === "CANCELED") ? o.why : undefined, lndState: o.lndState || undefined });

  // ---- the loop: watch invoices, pay, chase silent payouts
  // One tick at a time. setInterval doesn't wait for an async tick, so a slow
  // LND lookup would let two ticks both see ACCEPTED and both send M-Pesa.
  let ticking = false;
  async function tick() {
    if (ticking) return;
    ticking = true;
    try { await tickOnce(); } finally { ticking = false; }
  }
  async function tickOnce() {
    for (const o of orders.values()) {
      try {
        if (o.state === "INVOICED") {
          const inv = await lnd.lookup(o.hashHex);
          if (inv.state === "ACCEPTED") {
            save(o, { state: "LOCKED" });
            await payout(o);
          } else if (inv.state === "CANCELED") save(o, { state: "EXPIRED" });
        } else if (o.state === "LOCKED") {
          // Restarted after LOCKED, before PAYING: check the sats are still
          // there before asking M-Pesa, LND may have cancelled meanwhile.
          const inv = await lnd.lookup(o.hashHex);
          if (inv.state === "CANCELED") save(o, { state: "EXPIRED", why: "LND cancelled the invoice before M-Pesa was asked; nothing was sent." });
          else await payout(o); // paying now is safe, nothing was sent yet
        } else if (o.state === "PAYING") {
          const stale = Date.now() - Date.parse(o.updatedAt) > statusAfterMs && !o.asked;
          const inv = await lnd.lookup(o.hashHex);
          if (inv.state === "CANCELED" && o.lndState !== "CANCELED") {
            save(o, { lndState: "CANCELED", why: "LND cancelled the invoice while the M-Pesa payout is in flight." });
          }
          if (stale) {
            o.asked = true;
            await daraja.status({ originatorId: o.id });
            log(`[${o.id.slice(0, 8)}] no result yet: asked M-Pesa for the payout's status`);
          }
        }
      } catch (e) { log(`[${o.id.slice(0, 8)}] ${e.message}`); }
    }
  }

  async function payout(o) {
    // Write PAYING first. If we crash after this line we will ask M-Pesa what
    // happened (status query) instead of paying a second time.
    save(o, { state: "PAYING" });
    try {
      await daraja.pay({ originatorId: o.id, phone: o.phone, kes: o.kes, remarks: "Bitcoin off-ramp" });
    } catch (e) {
      // We don't know whether M-Pesa took the request: leave it PAYING and let the status query decide.
      log(`[${o.id.slice(0, 8)}] payout request error, will check status: ${e.message}`);
    }
  }

  async function onResult(body) {
    const r = parseResult(body);
    const o = orders.get(r.originatorId);
    if (!o || !["PAYING", "LOCKED"].includes(o.state)) return; // unknown or already final: ignore repeats
    if (r.utilityFunds !== undefined) saveFloat(Number(r.utilityFunds));
    if (r.ok) {
      try {
        await lnd.settle(o.preimageHex);
      } catch (e) {
        // The shillings left but the sats can't be claimed (LND cancelled the
        // invoice first): park the order where the operator can see it.
        if (r.utilityFunds === undefined) saveFloat(float - o.kes);
        save(o, { state: "NEEDS_REVIEW", receipt: r.receipt, why: `M-Pesa paid but LND settle failed: ${e.message}` });
        return;
      }
      save(o, { state: "PAID", receipt: r.receipt });
      if (r.utilityFunds === undefined) saveFloat(float - o.kes);
    } else if (r.final) {
      try {
        await lnd.cancel(o.hashHex);
      } catch (e) {
        const inv = await lnd.lookup(o.hashHex).catch(() => null);
        if (inv?.state === "CANCELED") {
          save(o, { state: "REFUNDED", why: `${r.code} ${r.desc} (invoice already cancelled)` });
          return;
        }
        save(o, { state: "NEEDS_REVIEW", why: `M-Pesa refused (${r.code} ${r.desc}) but LND cancel failed: ${e.message}; sats may still be locked.` });
        return;
      }
      save(o, { state: "REFUNDED", why: `${r.code} ${r.desc}` });
    } else {
      o.asked = false; // not final yet (e.g. still processing): ask again later
    }
  }

  // ---- HTTP
  const server = http.createServer(async (req, res) => {
    const send = (code, body) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    try {
      const body = await readJson(req);
      if (req.method === "POST" && req.url === "/quote") return send(200, await quote(body));
      if (req.method === "GET" && req.url.startsWith("/order/")) {
        const o = orders.get(req.url.slice(7));
        return o ? send(200, view(o)) : send(404, { error: "not found" });
      }
      // Safaricom's callbacks. In production put these behind a secret path and
      // Safaricom's published IP allowlist; a forged "success" would make us
      // settle without paying, so never trust a callback for an order that isn't PAYING.
      if (req.method === "POST" && (req.url === "/daraja/result" || req.url === "/daraja/status")) {
        await onResult(body);
        return send(200, { ResultCode: 0, ResultDesc: "Accepted" });
      }
      if (req.method === "POST" && req.url === "/daraja/timeout") return send(200, { ResultCode: 0 });
      send(404, { error: "not found" });
    } catch (e) { send(e.status || 500, { error: e.status ? e.message : "internal error" }); if (!e.status) log(e.stack); }
  });

  return { server, quote, tick, onResult, orders, float: () => float, reserved };
}

const httpErr = (status, message) => Object.assign(new Error(message), { status });
const readJson = (req) => new Promise((resolve, reject) => {
  let d = "";
  req.on("data", (c) => { d += c; if (d.length > 65_536) req.destroy(); });
  req.on("end", () => { try { resolve(d ? JSON.parse(d) : {}); } catch { reject(httpErr(400, "bad JSON")); } });
});
