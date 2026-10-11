// Still-open escalation reporting + the bounded daily "still waiting" digest.
//
// Why this file exists: on 2026-10-11 `notify_status` reported `escalated: 0` while five
// guest questions were genuinely open — the oldest 7.4 days, three of them prospective
// bookings worth real money. The in-window sweep was working as designed; the gap was that
// nothing reported past its recency guard and nothing ever followed up after the single
// one-shot backup. These tests pin both halves.
//
// Every assertion runs in-process with no Redis and no network: the digest is routed to an
// email recipient with no Resend key, so resendSend returns staged/not-sent without making
// a request. Nothing is ever sent to a guest or to staff from this file.

import assert from "node:assert/strict";

// HARD ISOLATION, FIRST — before the backend is imported.
// This file drives the real api/app.js, and setNotifyRaw/setApprovals write through to
// whatever store the module binds at import time. If a production KV or Resend credential
// is present in the environment, running the suite would overwrite live notification
// config and live approval records, and the "no Resend key so nothing can send" assumption
// would be false. Refuse to run instead of risking it.
const DANGEROUS = Object.keys(process.env).filter((k) =>
  /^(KV_|UPSTASH_|REDIS_)/.test(k) || k === "RESEND_API_KEY" || k === "SMS_GATEWAY_URL" ||
  k === "SMS_TWILIO_TOKEN" || k === "TWILIO_AUTH_TOKEN"
);
if (DANGEROUS.length && process.env.ALLOW_LIVE_STORE !== "1") {
  console.error(
    "REFUSING TO RUN: live store/transport credentials in the environment (" +
      DANGEROUS.join(", ") +
      "). These tests write notification config and approvals through the real module. " +
      "Unset them, or set ALLOW_LIVE_STORE=1 if you genuinely intend to touch that store."
  );
  process.exit(1);
}
for (const k of DANGEROUS) delete process.env[k];
process.env.APP_PASSWORD = "test-app-password";
const handler = (await import("../api/app.js")).default ?? (await import("../api/app.js"));
const mod = await import("../api/app.js");
const R = mod.default.__routing || mod.__routing;

const {
  openEscalationList,
  openEscalationSummary,
  remindOpenEscalations,
  setApprovals,
  setNotifyRaw,
  ESC_DIGEST_MAX_ITEMS,
} = R;

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed++;
  console.log("  ok  " + name);
};

const hoursAgo = (h) => new Date(Date.now() - h * 3600e3).toISOString();
const item = (label, h, extra = {}) => ({
  id: "id-" + label,
  smsLabel: label,
  status: "escalated",
  ts: hoursAgo(h),
  primaryNotifiedAt: hoursAgo(h),
  ...extra,
});

// Backup route that cannot send: email with a recipient but no Resend key.
const stagedRoute = async () =>
  setNotifyRaw({
    routes: {
      normal: { channel: "email", recipient: "frontdesk@example.invalid" },
      complaint: { channel: "email", recipient: "frontdesk@example.invalid" },
      backup: { channel: "email", recipient: "backup@example.invalid" },
    },
  });

console.log("escalation visibility + digest");

await test("reports escalated items of ANY age, oldest first", async () => {
  const list = [
    item("Q368", 178, { backupAskSent: true, unit: "Flyin' Horse", guest_name: "Jenny" }),
    item("Q386", 26, { backupAskSent: true, guest_name: "Dafne" }),
    item("Q387", 25.6, { backupAskSent: true, partialAnswered: true }),
    item("Q999", 0.08),
    { id: "done", smsLabel: "Q500", status: "approved", ts: hoursAgo(1) },
    { id: "pend", smsLabel: "Q501", status: "pending", ts: hoursAgo(1) },
  ];
  const s = openEscalationSummary(list);
  assert.equal(s.count, 4, "only escalated items count");
  assert.equal(s.oldestAgeH, 178, "a 7-day-old item must still be reported");
  assert.equal(s.neverNotified, 1, "Q999 has not had its one-shot yet");
  assert.deepEqual(s.items.map((x) => x.label), ["Q368", "Q386", "Q387", "Q999"]);
  assert.equal(s.items[0].guest, "Jenny");
  assert.equal(s.items[0].unit, "Flyin' Horse");
});

await test("survives missing/garbage timestamps without throwing", async () => {
  const s = openEscalationSummary([
    { id: "x", smsLabel: "Qx", status: "escalated" },
    { id: "y", smsLabel: "Qy", status: "escalated", ts: "not-a-date" },
    null,
    undefined,
  ]);
  assert.equal(s.count, 2);
  assert.equal(s.items.every((x) => x.ageH === null), true, "unknown age is null, never NaN");
});

await test("empty and non-array input are safe", async () => {
  assert.equal(openEscalationList(undefined).length, 0);
  assert.equal(openEscalationList(null).length, 0);
  assert.equal(openEscalationSummary([]).count, 0);
  assert.equal(openEscalationSummary([]).oldestAgeH, null);
});

await test("digest stays silent when nothing is open", async () => {
  await stagedRoute();
  await setApprovals([{ id: "a", smsLabel: "Q1", status: "approved", ts: hoursAgo(2) }]);
  const r = await remindOpenEscalations({ headers: {} });
  assert.equal(r.sent, false);
  assert.equal(r.reason, "nothing still open");
});

await test("digest ignores items that have not had their one-shot yet", async () => {
  await stagedRoute();
  await setApprovals([item("Q999", 0.08)]);
  const r = await remindOpenEscalations({ headers: {} });
  assert.equal(r.sent, false);
  assert.equal(r.reason, "nothing still open", "the one-shot sweep still owns fresh items");
});

await test("digest includes items the recency guard neutralised — the whole point", async () => {
  await stagedRoute();
  await setApprovals([item("Q371", 145, { backupSkippedStale: true })]);
  const r = await remindOpenEscalations({ headers: {} });
  assert.equal(r.count, 1, "backupSkippedStale items were previously invisible forever");
  assert.equal(r.channel, "email");
  assert.equal(r.to, "backup@example.invalid");
});

await test("digest caps itemised entries and counts the remainder", async () => {
  await stagedRoute();
  const many = [];
  for (let i = 0; i < ESC_DIGEST_MAX_ITEMS + 5; i++) many.push(item("Q" + (600 + i), 10 + i, { backupAskSent: true }));
  await setApprovals(many);
  const r = await remindOpenEscalations({ headers: {} });
  assert.equal(r.count, ESC_DIGEST_MAX_ITEMS + 5);
  assert.equal(r.shown, ESC_DIGEST_MAX_ITEMS, "never itemise more than the cap");
  assert.equal(r.more, 5, "the rest are summarised as a count");
});

await test("an UNAMBIGUOUS failure releases the day marker so the next run may retry", async () => {
  await stagedRoute();
  await setApprovals([item("Q386", 26, { backupAskSent: true })]);
  const first = await remindOpenEscalations({ headers: {} });
  assert.equal(first.sent, false, "no Resend key -> staged, not sent");
  assert.equal(first.retryable, true, "staged means the transport refused before sending");
  const second = await remindOpenEscalations({ headers: {} });
  assert.notEqual(second.reason, "already sent today", "a known-failed send must not burn the day");
});

await test("an AMBIGUOUS transport failure KEEPS the marker (no duplicate nag)", async () => {
  // Connection refused on closed localhost port 1: sendSmsGateway's catch returns a bare
  // {sent:false, error} with no HTTP status — indistinguishable from "the provider accepted
  // it and only the response read failed". That must NOT be treated as retryable, or the
  // 5-minute cron would re-send all day. No external network, nothing delivered anywhere.
  await setNotifyRaw({
    smsGatewayUrl: "http://127.0.0.1:1/never",
    routes: {
      normal: { channel: "email", recipient: "frontdesk@example.invalid" },
      complaint: { channel: "email", recipient: "frontdesk@example.invalid" },
      backup: { channel: "sms", recipient: "+15550000000" },
    },
  });
  await setApprovals([item("Q386", 26, { backupAskSent: true })]);
  const first = await remindOpenEscalations({ headers: {} });
  assert.equal(first.sent, false);
  assert.equal(first.retryable, false, "no HTTP status => outcome unknown => not retryable");
  assert.equal(first.uncertain, true, "must be reported as uncertain");
  const second = await remindOpenEscalations({ headers: {} });
  assert.equal(second.reason, "already sent today", "ambiguity must hold the marker for the day");
});

await test("the off switch silences it without a redeploy", async () => {
  await setNotifyRaw({
    escalationDigest: false,
    routes: {
      normal: { channel: "email", recipient: "frontdesk@example.invalid" },
      complaint: { channel: "email", recipient: "frontdesk@example.invalid" },
      backup: { channel: "email", recipient: "backup@example.invalid" },
    },
  });
  await setApprovals([item("Q386", 26, { backupAskSent: true })]);
  const r = await remindOpenEscalations({ headers: {} });
  assert.equal(r.sent, false);
  assert.equal(r.reason, "digest turned off");
});

await test("no backup recipient is reported, not thrown", async () => {
  await setNotifyRaw({
    routes: {
      normal: { channel: "email", recipient: "frontdesk@example.invalid" },
      complaint: { channel: "email", recipient: "frontdesk@example.invalid" },
      backup: { channel: "email", recipient: "" },
    },
  });
  await setApprovals([item("Q386", 26, { backupAskSent: true })]);
  const r = await remindOpenEscalations({ headers: {} });
  assert.equal(r.sent, false);
  assert.equal(r.reason, "no backup recipient set");
});

await test("the digest never writes to the approval records", async () => {
  await stagedRoute();
  const before = [item("Q386", 26, { backupAskSent: true })];
  await setApprovals(JSON.parse(JSON.stringify(before)));
  await remindOpenEscalations({ headers: {} });
  const after = await R.getApprovals();
  assert.equal(after[0].status, "escalated", "reporting must not resolve anything");
  assert.equal(after[0].backupAskSent, true);
  assert.equal(after[0].backupSkippedStale, undefined, "must not touch the one-shot guard");
});

console.log("\n" + passed + "/" + passed + " passed");
