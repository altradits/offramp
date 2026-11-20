// M-Pesa B2C (business to customer) through Safaricom's Daraja API.
// Same calls against the sandbox, production, or the local mock in mock-daraja.mjs.
import crypto from "node:crypto";
import fs from "node:fs";

export function darajaClient({ baseUrl, consumerKey, consumerSecret, initiator, initiatorPassword, certPath, shortcode, resultUrl, statusUrl, timeoutUrl }) {
  let token = null, tokenUntil = 0;

  async function auth() {
    if (token && Date.now() < tokenUntil) return token;
    const basic = Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64");
    const r = await fetch(`${baseUrl}/oauth/v1/generate?grant_type=client_credentials`, { headers: { Authorization: `Basic ${basic}` } });
    if (!r.ok) throw new Error(`Daraja auth ${r.status}`);
    const j = await r.json();
    token = j.access_token;
    tokenUntil = Date.now() + (Number(j.expires_in) - 60) * 1000; // refresh a minute early
    return token;
  }

  // The initiator password, RSA-encrypted (PKCS#1 v1.5) with Safaricom's
  // public certificate. The plain password never leaves this server.
  const securityCredential = () =>
    crypto.publicEncrypt(
      { key: fs.readFileSync(certPath), padding: crypto.constants.RSA_PKCS1_PADDING },
      Buffer.from(initiatorPassword),
    ).toString("base64");

  async function post(path, body) {
    const r = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await auth()}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || String(j.ResponseCode) !== "0") throw new Error(`Daraja ${path} ${r.status} ${j.errorMessage || j.ResponseDescription || ""}`);
    return j;
  }

  return {
    // originatorId must be unique per payout and reused on retries: it is
    // what stops one payout from being paid twice.
    pay: ({ originatorId, phone, kes, remarks }) =>
      post("/mpesa/b2c/v3/paymentrequest", {
        OriginatorConversationID: originatorId,
        InitiatorName: initiator,
        SecurityCredential: securityCredential(),
        CommandID: "BusinessPayment",
        Amount: String(kes),
        PartyA: shortcode,
        PartyB: phone,
        Remarks: remarks,
        QueueTimeOutURL: timeoutUrl,
        ResultURL: resultUrl,
        Occassion: "offramp",
      }),
    // Asks M-Pesa what happened to an earlier payout. The answer arrives later
    // on statusUrl, in a different shape from the payout result (parseResult reads both).
    status: ({ originatorId }) =>
      post("/mpesa/transactionstatus/v1/query", {
        Initiator: initiator,
        SecurityCredential: securityCredential(),
        CommandID: "TransactionStatusQuery",
        OriginalConversationID: originatorId,
        PartyA: shortcode,
        IdentifierType: "4",
        ResultURL: statusUrl,
        QueueTimeOutURL: timeoutUrl,
        Remarks: "status",
        Occasion: "offramp",
      }),
  };
}

// The callback body, flattened: { ok, code, desc, originatorId, receipt, amount, utilityFunds }
export function parseResult(body) {
  const r = body?.Result || {};
  const params = Object.fromEntries((r.ResultParameters?.ResultParameter || []).map((p) => [p.Key, p.Value]));
  if ("TransactionStatus" in params) {
    // A status-query answer: the top-level OriginatorConversationID is the
    // query's own; the payout it describes is named inside ResultParameters.
    return {
      ok: Number(r.ResultCode) === 0 && params.TransactionStatus === "Completed",
      final: Number(r.ResultCode) === 0 && ["Completed", "Failed", "Cancelled", "Expired"].includes(params.TransactionStatus),
      code: Number(r.ResultCode), desc: `${r.ResultDesc} (${params.TransactionStatus})`,
      originatorId: params.OriginatorConversationID, receipt: params.ReceiptNo || null, amount: Number(params.Amount),
    };
  }
  return {
    final: true,
    ok: Number(r.ResultCode) === 0,
    code: Number(r.ResultCode),
    desc: r.ResultDesc,
    originatorId: r.OriginatorConversationID,
    receipt: params.TransactionReceipt || r.TransactionID || null,
    amount: params.TransactionAmount,
    utilityFunds: params.B2CUtilityAccountAvailableFunds,
  };
}
