// Minimal LND REST client for hold invoices. Uses the invoice macaroon only:
// it can create, settle and cancel invoices, and it cannot send money.
import https from "node:https";
import fs from "node:fs";

export function lndClient({ url, certPath, macaroonPath }) {
  const ca = fs.readFileSync(certPath);
  const mac = fs.readFileSync(macaroonPath).toString("hex");
  const base = new URL(url);

  const call = (method, path, body) =>
    new Promise((resolve, reject) => {
      const req = https.request(
        { host: base.hostname, port: base.port, path, method, ca,
          headers: { "Grpc-Metadata-macaroon": mac, "Content-Type": "application/json" } },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            const json = data ? JSON.parse(data) : {};
            if (res.statusCode >= 400) reject(new Error(`LND ${res.statusCode}: ${json.message || data}`));
            else resolve(json);
          });
        });
      req.on("error", reject);
      req.setTimeout(10_000, () => req.destroy(new Error("LND timeout")));
      if (body) req.write(JSON.stringify(body));
      req.end();
    });

  const b64 = (hex) => Buffer.from(hex, "hex").toString("base64");

  return {
    // An invoice LND will accept but not settle: the payer's sats stay locked
    // in the channel until we either reveal the preimage (settle) or cancel.
    addHold: ({ hashHex, sats, memo, expirySec, cltvExpiry }) =>
      call("POST", "/v2/invoices/hodl", {
        hash: b64(hashHex), value: String(sats), memo,
        expiry: String(expirySec), cltv_expiry: String(cltvExpiry),
      }),
    // state: OPEN (unpaid), ACCEPTED (sats locked), SETTLED, CANCELED
    lookup: (hashHex) => call("GET", `/v1/invoice/${hashHex}`),
    settle: (preimageHex) => call("POST", "/v2/invoices/settle", { preimage: b64(preimageHex) }),
    cancel: (hashHex) => call("POST", "/v2/invoices/cancel", { payment_hash: b64(hashHex) }),
    height: async () => Number((await call("GET", "/v1/getinfo")).block_height),
  };
}
