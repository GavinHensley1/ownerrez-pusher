// OwnerRez SpotRates pusher â pricing ONLY. Dry-run by default.
// POST a SpotRates array (or {spotrates:[...]}) -> validate -> PATCH /v2/spotrates.
// Boundaries (per OWNERREZ_INTEGRATION_BRIEF): pricing only; never zero out rates;
// reject empty payloads; sanity-guard amounts to $50..$1000.
const OWNERREZ_ENDPOINT = "https://api.ownerrez.com/v2/spotrates";
const MIN_AMOUNT = 50;
const MAX_AMOUNT = 1000;

function validate(entries) {
  const valid = [], invalid = [], outOfRange = [];
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  for (const e of entries) {
    const pid = e && e.property_id;
    const okPid = Number.isInteger(pid) || (typeof pid === "string" && /^\d+$/.test(pid));
    const okDate = e && typeof e.date === "string" && dateRe.test(e.date);
    const amt = e && (typeof e.amount === "number" ? e.amount : Number(e.amount));
    const okAmt = Number.isFinite(amt) && amt > 0;
    const okCur = e && e.currency === "USD";
    if (!okPid || !okDate || !okAmt || !okCur) { invalid.push(e); continue; }
    if (amt < MIN_AMOUNT || amt > MAX_AMOUNT) { outOfRange.push(e); continue; }
    valid.push({ property_id: Number(pid), date: e.date, amount: Math.round(amt * 100) / 100, currency: "USD" });
  }
  return { valid, invalid, outOfRange };
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const secret = process.env.PUSH_SECRET;
  if (secret && req.headers["x-push-secret"] !== secret) {
    return res.status(401).json({ error: "missing or invalid x-push-secret header" });
  }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "invalid JSON body" }); } }
  const entries = Array.isArray(body) ? body : (body && Array.isArray(body.spotrates) ? body.spotrates : null);
  if (!entries) return res.status(400).json({ error: "body must be a SpotRates array or {spotrates:[...]}" });
  if (entries.length === 0) return res.status(400).json({ error: "empty payload â refusing to push (never zero out rates)" });

  const { valid, invalid, outOfRange } = validate(entries);

  const allowWrites = process.env.PUSH_ALLOW_WRITES === "true";
  const live = req.query && (req.query.live === "1" || req.query.live === "true");
  const willSend = Boolean(allowWrites && live);

  const summary = {
    mode: willSend ? "LIVE" : "DRY_RUN",
    received: entries.length,
    valid: valid.length,
    invalid: invalid.length,
    outOfRange: outOfRange.length,
    sample: valid.slice(0, 3),
    invalidSample: invalid.slice(0, 5),
    outOfRangeSample: outOfRange.slice(0, 5),
  };

  if (!willSend) {
    console.log("[pusher] DRY_RUN", JSON.stringify({ received: summary.received, valid: summary.valid }));
    return res.status(200).json({ ...summary, note: "Dry run. Set PUSH_ALLOW_WRITES=true (env) and call with ?live=1 to PATCH OwnerRez." });
  }

  const user = process.env.OWNERREZ_API_USER, token = process.env.OWNERREZ_API_TOKEN;
  if (!user || !token) return res.status(500).json({ ...summary, error: "missing OWNERREZ_API_USER / OWNERREZ_API_TOKEN env" });
  if (valid.length === 0) return res.status(400).json({ ...summary, error: "no valid entries to send" });

  const auth = "Basic " + Buffer.from(`${user}:${token}`).toString("base64");
  try {
    const r = await fetch(OWNERREZ_ENDPOINT, {
      method: "PATCH",
      headers: { Authorization: auth, "Content-Type": "application/json", "User-Agent": "parkside-pricing-pusher/1.0" },
      body: JSON.stringify(valid),
    });
    const text = await r.text();
    let parsed; try { parsed = JSON.parse(text); } catch { parsed = text.slice(0, 800); }
    console.log("[pusher] LIVE", r.status, JSON.stringify({ sent: valid.length }));
    return res.status(r.ok ? 200 : 502).json({ ...summary, sent: valid.length, ownerrezStatus: r.status, ownerrezBody: parsed });
  } catch (err) {
    console.error("[pusher] ERROR", err.message);
    return res.status(502).json({ ...summary, error: "OwnerRez request failed: " + err.message });
  }
};
