// The price: a median of independent public sources, so one bad or stale
// source cannot move the quote. BTC/USD from three exchanges, USD/KES from
// two FX feeds. No API keys needed.
const get = async (url) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(6000), headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  return r.json();
};

export const BTC_USD = {
  kraken: async () => Number((await get("https://api.kraken.com/0/public/Ticker?pair=XBTUSD")).result.XXBTZUSD.c[0]),
  coinbase: async () => Number((await get("https://api.coinbase.com/v2/prices/BTC-USD/spot")).data.amount),
  bitstamp: async () => Number((await get("https://www.bitstamp.net/api/v2/ticker/btcusd/")).last),
};
export const USD_KES = {
  erapi: async () => Number((await get("https://open.er-api.com/v6/latest/USD")).rates.KES),
  fawaz: async () => Number((await get("https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json")).usd.kes),
};

export const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

async function settled(sources) {
  const names = Object.keys(sources);
  const res = await Promise.allSettled(names.map((n) => sources[n]()));
  const ok = {};
  res.forEach((r, i) => { if (r.status === "fulfilled" && Number.isFinite(r.value) && r.value > 0) ok[names[i]] = r.value; });
  return ok;
}

// Refuse to quote when sources are missing or disagree by more than maxSpread:
// a wrong price is worse than no price.
export async function btcKes({ minSources = 2, maxSpread = 0.02 } = {}) {
  const [usd, kes] = await Promise.all([settled(BTC_USD), settled(USD_KES)]);
  for (const [label, got] of [["BTC/USD", usd], ["USD/KES", kes]]) {
    const v = Object.values(got);
    if (v.length < minSources) throw new Error(`only ${v.length} ${label} source(s) answered`);
    const spread = (Math.max(...v) - Math.min(...v)) / median(v);
    if (spread > maxSpread) throw new Error(`${label} sources disagree by ${(spread * 100).toFixed(2)}%`);
  }
  const btcUsd = median(Object.values(usd));
  const usdKes = median(Object.values(kes));
  return { btcUsd, usdKes, btcKes: btcUsd * usdKes, sources: { usd, kes }, at: new Date().toISOString() };
}

// How many sats a payout of `kes` shillings costs the customer, fee included.
// Rounded up so the service never pays out more than it was paid, after
// trimming floating-point noise: (10 / 8e6) * 1e8 is 125.00000000000001 in
// JavaScript, and a bare Math.ceil would charge 126.
export const satsFor = (kes, btcKes, feePct) => Math.ceil(Number(((kes / btcKes) * 1e8 * (1 + feePct / 100)).toFixed(6)));
