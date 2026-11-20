// A local stand-in for Safaricom's Daraja B2C and Transaction Status APIs,
// built from the request and callback shapes in Safaricom's documentation.
// It checks what the real API checks first (OAuth token, encrypted initiator
// password) and calls back like M-Pesa does. MODE picks the outcome:
//   ok       pays and calls back with ResultCode 0 and a receipt
//   nofloat  calls back with ResultCode 1 (the B2C account balance is insufficient)
//   silent   accepts the request, pays, but never calls back (only a status query reveals it)
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";

export function mockDaraja({ port, key, secret, initiator, password, privateKeyPath, utility = 20_000, mode = () => "ok", delayMs = 1500 }) {
  const priv = fs.readFileSync(privateKeyPath);
  const tokens = new Set();
  const paid = new Map(); // OriginatorConversationID -> receipt
  let balance = utility;
  let payRequests = 0;

  const callback = (url, body) => setTimeout(() => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => {}), delayMs);
  const receipt = () => "T" + crypto.randomBytes(5).toString("hex").toUpperCase().slice(0, 9);
  const conv = () => "AG_" + new Date().toISOString().slice(0, 10).replaceAll("-", "") + "_" + crypto.randomBytes(8).toString("hex");

  const server = http.createServer(async (req, res) => {
    const send = (code, body) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/oauth/v1/generate") {
      if (req.headers.authorization !== "Basic " + Buffer.from(`${key}:${secret}`).toString("base64")) return send(400, { errorMessage: "Invalid Authentication passed" });
      const t = crypto.randomBytes(16).toString("hex"); tokens.add(t);
      return send(200, { access_token: t, expires_in: "3599" });
    }
    if (!tokens.has(String(req.headers.authorization).replace("Bearer ", ""))) return send(401, { errorMessage: "Invalid Access Token" });
    let b = ""; for await (const c of req) b += c; b = JSON.parse(b || "{}");
    const credOk = (() => { try { return crypto.privateDecrypt({ key: priv, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(b.SecurityCredential, "base64")).toString() === password; } catch { return false; } })();
    const ack = { ConversationID: conv(), OriginatorConversationID: b.OriginatorConversationID, ResponseCode: "0", ResponseDescription: "Accept the service request successfully." };

    if (u.pathname === "/mpesa/b2c/v3/paymentrequest") {
      payRequests++;
      send(200, ack);
      const result = (code, desc, params) => ({ Result: { ResultType: 0, ResultCode: code, ResultDesc: desc, OriginatorConversationID: b.OriginatorConversationID, ConversationID: ack.ConversationID, TransactionID: params?.receipt || receipt(),
        ...(params ? { ResultParameters: { ResultParameter: [
          { Key: "TransactionAmount", Value: Number(b.Amount) }, { Key: "TransactionReceipt", Value: params.receipt },
          { Key: "ReceiverPartyPublicName", Value: `${b.PartyB} - TEST CUSTOMER` }, { Key: "TransactionCompletedDateTime", Value: new Date().toISOString() },
          { Key: "B2CUtilityAccountAvailableFunds", Value: balance }, { Key: "B2CRecipientIsRegisteredCustomer", Value: "Y" } ] } } : {}) } });
      if (!credOk || b.InitiatorName !== initiator) return callback(b.ResultURL, result(2001, "The initiator information is invalid."));
      // The lab's stand-in for "this number has no M-Pesa account": 0733 numbers.
      if (/^25473/.test(String(b.PartyB))) return callback(b.ResultURL, result(2040, "Credit Party customer type (Unregistered or Registered Customer) can't be supported by the service."));
      const m = mode(b);
      if (m === "nofloat" || Number(b.Amount) > balance) return callback(b.ResultURL, result(1, "The balance is insufficient for the transaction."));
      if (paid.has(b.OriginatorConversationID)) return; // a repeat of a payout already made: never pay twice
      const r = receipt(); balance -= Number(b.Amount); paid.set(b.OriginatorConversationID, { receipt: r, amount: Number(b.Amount) });
      console.log(`  [M-Pesa mock] paid KES ${b.Amount} to ${b.PartyB}, receipt ${r}, utility balance ${balance}`);
      if (m === "silent") return;
      return callback(b.ResultURL, result(0, "The service request is processed successfully.", { receipt: r }));
    }
    if (u.pathname === "/mpesa/transactionstatus/v1/query") {
      send(200, ack);
      const p = paid.get(b.OriginalConversationID);
      const params = [{ Key: "OriginatorConversationID", Value: b.OriginalConversationID }, { Key: "TransactionStatus", Value: p ? "Completed" : "Failed" },
        { Key: "ReceiptNo", Value: p?.receipt || "" }, { Key: "Amount", Value: String(p?.amount || 0) }, { Key: "DebitAccountType", Value: "Utility Account" }];
      return callback(b.ResultURL, { Result: { ResultType: 0, ResultCode: 0, ResultDesc: "The service request is processed successfully.", OriginatorConversationID: ack.OriginatorConversationID, ConversationID: ack.ConversationID, ResultParameters: { ResultParameter: params } } });
    }
    send(404, { errorMessage: "not found" });
  });
  server.listen(port, "127.0.0.1");
  return { server, balance: () => balance, payRequests: () => payRequests };
}
