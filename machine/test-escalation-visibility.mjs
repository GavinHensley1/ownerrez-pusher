// Still-open escalation reporting + the bounded daily "still waiting" digest.
//
// Why this file exists: on 2026-10-11 `notify_status` reported `escalated: 0` while five
// guest questions were genuinely open — the oldest 7.4 days, three of them prospective
// bookings worth real money. The in-window sweep was working as designed; the gap was that
// nothing reported past its recency guard and nothing ever followed up after the single
// one-shot backup. These tests pin both halves.
//
// Every assertion runs in-process with no Redis and no EXTERNAL network. Most tests route
// the digest to an email recipient with no Resend key, so resendSend returns staged/not-sent
// without making a request. The send-path tests point the SMS gateway at a stub bound to
// 127.0.0.1 on an ephemeral port, so the only socket is loopback and the bytes staff would
// have received are asserted directly. Nothing is ever sent to a guest or to staff.

import assert from "node:assert/strict";
import http from "node:http";

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
  escalationDigestDayKey,
  escalationDigestLocalHour,
  escalationDigestWindowOpen,
  resetEscalationDigestMarker,
} = R;

// Every send-path assertion runs against a FIXED clock, 9:05am ET, inside the reminder
// window. Without it the suite would pass or fail depending on what time of day it was run,
// and the overnight-quiet rule would make that failure look like a real regression.
const IN_WINDOW = new Date("2026-10-12T13:05:00Z");

let passed = 0;
const test = async (name, fn) => {
  // Per-case fixture: the day marker is process-global, and some cases deliberately leave it
  // held. Each test starts from a known state so none of them inherits another's marker.
  resetEscalationDigestMarker();
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

// Loopback-only stand-in for the SMS gateway. Binds 127.0.0.1 on an ephemeral port, always
// answers 200, and records every body it received — that recording is what lets us prove the
// once-a-day guarantee on a SUCCESSFUL send, which no amount of staged/failed testing can.
const withStubGateway = async (run) => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      seen.push(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "stub-" + seen.length, state: "Pending" }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = "http://127.0.0.1:" + server.address().port + "/send";
  try {
    return await run(url, seen);
  } finally {
    await new Promise((r) => server.close(r));
  }
};

const smsBackupRoute = async (url) =>
  setNotifyRaw({
    smsGatewayUrl: url,
    routes: {
      normal: { channel: "email", recipient: "frontdesk@example.invalid" },
      complaint: { channel: "email", recipient: "frontdesk@example.invalid" },
      backup: { channel: "sms", recipient: "+15550000000" },
    },
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
  // These used to throw "(list || []).filter is not a function" and take the whole status
  // endpoint down with them — a single record passed by mistake, or a store read that
  // answered `{}` instead of a list. Reporting must not be the thing that breaks.
  assert.equal(openEscalationList({}).length, 0);
  assert.equal(openEscalationList("nope").length, 0);
  assert.equal(openEscalationList(7).length, 0);
  assert.equal(openEscalationSummary({}).count, 0);
  assert.equal(openEscalationSummary({}).oldestAgeH, null);
  assert.equal(openEscalationSummary([]).count, 0);
  assert.equal(openEscalationSummary([]).oldestAgeH, null);
});

await test("the day marker follows the property's calendar day, not UTC", async () => {
  // 7:59pm and 8:00pm Eastern on the same evening. A UTC-keyed marker changes between these
  // two instants, which would have let the cron send a second digest 60 seconds after the
  // first — the exact duplicate nag the marker exists to prevent.
  assert.equal(escalationDigestDayKey(new Date("2026-10-11T23:59:30Z")), "2026-10-11");
  assert.equal(
    escalationDigestDayKey(new Date("2026-10-12T00:00:30Z")),
    "2026-10-11",
    "UTC rollover at 8pm ET must not start a new digest day"
  );
  // Local midnight is the real seam, where nobody is reading texts.
  assert.equal(escalationDigestDayKey(new Date("2026-10-12T03:59:00Z")), "2026-10-11", "11:59pm ET is the same day");
  assert.equal(escalationDigestDayKey(new Date("2026-10-12T04:00:30Z")), "2026-10-12", "12:00am ET starts the next");
  assert.equal(escalationDigestDayKey(new Date("not-a-date")), "invalid-date", "never build a NaN key");
});

await test("digest stays silent when nothing is open", async () => {
  await stagedRoute();
  await setApprovals([{ id: "a", smsLabel: "Q1", status: "approved", ts: hoursAgo(2) }]);
  const r = await remindOpenEscalations({ headers: {} }, { now: IN_WINDOW });
  assert.equal(r.sent, false);
  assert.equal(r.reason, "nothing still open");
});

await test("digest ignores items that have not had their one-shot yet", async () => {
  await stagedRoute();
  await setApprovals([item("Q999", 0.08)]);
  const r = await remindOpenEscalations({ headers: {} }, { now: IN_WINDOW });
  assert.equal(r.sent, false);
  assert.equal(r.reason, "nothing still open", "the one-shot sweep still owns fresh items");
});

await test("digest includes items the recency guard neutralised — the whole point", async () => {
  await stagedRoute();
  await setApprovals([item("Q371", 145, { backupSkippedStale: true })]);
  const r = await remindOpenEscalations({ headers: {} }, { now: IN_WINDOW });
  assert.equal(r.count, 1, "backupSkippedStale items were previously invisible forever");
  assert.equal(r.channel, "email");
  assert.equal(r.to, "backup@example.invalid");
});

await test("digest caps itemised entries and counts the remainder", async () => {
  await stagedRoute();
  const many = [];
  for (let i = 0; i < ESC_DIGEST_MAX_ITEMS + 5; i++) many.push(item("Q" + (600 + i), 10 + i, { backupAskSent: true }));
  await setApprovals(many);
  const r = await remindOpenEscalations({ headers: {} }, { now: IN_WINDOW });
  assert.equal(r.count, ESC_DIGEST_MAX_ITEMS + 5);
  assert.equal(r.shown, ESC_DIGEST_MAX_ITEMS, "never itemise more than the cap");
  assert.equal(r.more, 5, "the rest are summarised as a count");
});

await test("an UNAMBIGUOUS failure releases the day marker so the next run may retry", async () => {
  await stagedRoute();
  await setApprovals([item("Q386", 26, { backupAskSent: true })]);
  const first = await remindOpenEscalations({ headers: {} }, { now: IN_WINDOW });
  assert.equal(first.sent, false, "no Resend key -> staged, not sent");
  assert.equal(first.retryable, true, "staged means the transport refused before sending");
  const second = await remindOpenEscalations({ headers: {} }, { now: IN_WINDOW });
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
  const first = await remindOpenEscalations({ headers: {} }, { now: IN_WINDOW });
  assert.equal(first.sent, false);
  assert.equal(first.retryable, false, "no HTTP status => outcome unknown => not retryable");
  assert.equal(first.uncertain, true, "must be reported as uncertain");
  const second = await remindOpenEscalations({ headers: {} }, { now: IN_WINDOW });
  assert.equal(second.reason, "already sent today", "ambiguity must hold the marker for the day");
});

await test("a SUCCESSFUL send burns the day exactly once", async () => {
  // The guarantee that actually matters, and the one every staged/failed test above leaves
  // untested: once staff have really been texted, the 5-minute cron must not text them again.
  await withStubGateway(async (url, seen) => {
    await smsBackupRoute(url);
    await setApprovals([item("Q386", 26, { backupAskSent: true })]);

    const first = await remindOpenEscalations({ headers: {} }, { now: IN_WINDOW });
    assert.equal(first.sent, true, "the stub gateway accepted it");
    assert.equal(first.uncertain, false, "a 200 is not ambiguous");
    assert.equal(first.retryable, false, "a delivered digest is not retryable");

    const second = await remindOpenEscalations({ headers: {} }, { now: IN_WINDOW });
    assert.equal(second.sent, false);
    assert.equal(second.reason, "already sent today", "a successful send must hold the day");

    const third = await remindOpenEscalations({ headers: {} }, { now: IN_WINDOW });
    assert.equal(third.reason, "already sent today", "and keep holding it");
    assert.equal(seen.length, 1, "exactly one message reached the gateway across three runs");
  });
});

await test("the message staff receive is capped, oldest-first, and counts the remainder", async () => {
  // Asserts the actual bytes posted to the transport, not just the returned counts: a cap
  // that reports shown:8 while rendering all 13 lines would still be a wall of text.
  await withStubGateway(async (url, seen) => {
    await smsBackupRoute(url);
    const many = [];
    for (let i = 0; i < ESC_DIGEST_MAX_ITEMS + 5; i++) {
      many.push(item("Q" + (700 + i), 10 + i, { backupAskSent: true }));
    }
    await setApprovals(many);

    const r = await remindOpenEscalations({ headers: {} }, { now: IN_WINDOW });
    assert.equal(r.sent, true);
    assert.equal(seen.length, 1);

    const text = JSON.parse(seen[0]).textMessage.text;
    const lines = text.split("\n").map((l) => l.trim());
    const itemised = lines.filter((l) => /^Q\d+\b/.test(l));
    assert.equal(itemised.length, ESC_DIGEST_MAX_ITEMS, "never itemise more than the cap");
    assert.match(text, /Still waiting for an answer \(13\)/, "the real total is stated");
    assert.match(text, /\+5 more/, "the uncapped remainder is summarised");
    assert.match(itemised[0], /^Q712\b/, "oldest first");
    assert.equal(itemised.some((l) => /^Q700\b/.test(l)), false, "the newest falls past the cap");
    assert.match(text, /text the Q number/, "staff are told how to answer");
  });
});

await test("the reminder window covers waking hours only", async () => {
  const at = (iso) => escalationDigestWindowOpen(new Date(iso));
  // 12:00am ET is exactly the hour the local-day marker fix would otherwise have delivered
  // to, because the cron runs every 5 minutes and would fire on the first post-rollover run.
  assert.equal(at("2026-10-12T04:00:30Z"), false, "12:00am ET");
  assert.equal(at("2026-10-12T06:30:00Z"), false, "2:30am ET");
  assert.equal(at("2026-10-12T11:59:00Z"), false, "7:59am ET");
  assert.equal(at("2026-10-12T12:00:00Z"), true, "8:00am ET opens it");
  assert.equal(at("2026-10-12T01:30:00Z"), true, "9:30pm ET is still inside");
  assert.equal(at("2026-10-12T02:00:00Z"), false, "10:00pm ET is out");
  assert.equal(escalationDigestLocalHour(new Date("2026-10-12T04:00:30Z")), 0, "midnight is 0, never 24");
  assert.equal(escalationDigestWindowOpen(new Date("nope")), true, "an unknown hour must not silence it");
});

await test("an overnight run stays quiet WITHOUT burning the day", async () => {
  // The regression this guards: keying the marker to the local day moves the first
  // post-rollover cron run to midnight ET. Skipping must not take the marker, or the
  // reminder would be swallowed and never arrive at all.
  await withStubGateway(async (url, seen) => {
    await smsBackupRoute(url);
    await setApprovals([item("Q386", 26, { backupAskSent: true })]);

    const night = await remindOpenEscalations({ headers: {} }, { now: new Date("2026-10-12T06:30:00Z") });
    assert.equal(night.sent, false);
    assert.equal(night.reason, "outside the daily reminder window");
    assert.equal(night.hour, 2, "2:30am ET");
    assert.equal(night.count, 1, "the backlog is still reported while quiet");
    assert.equal(seen.length, 0, "staff are not texted at 2:30am");

    // Same local day, first run after 8am.
    const morning = await remindOpenEscalations({ headers: {} }, { now: new Date("2026-10-12T13:05:00Z") });
    assert.equal(morning.sent, true, "the overnight skip must not have burned the day");
    assert.equal(seen.length, 1);

    const afternoon = await remindOpenEscalations({ headers: {} }, { now: new Date("2026-10-12T18:00:00Z") });
    assert.equal(afternoon.reason, "already sent today", "2pm ET the same day");
    assert.equal(seen.length, 1, "still exactly one digest for the day");
  });
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
  const r = await remindOpenEscalations({ headers: {} }, { now: IN_WINDOW });
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
  const r = await remindOpenEscalations({ headers: {} }, { now: IN_WINDOW });
  assert.equal(r.sent, false);
  assert.equal(r.reason, "no backup recipient set");
});

await test("the digest never writes to the approval records", async () => {
  await stagedRoute();
  const before = [item("Q386", 26, { backupAskSent: true })];
  await setApprovals(JSON.parse(JSON.stringify(before)));
  await remindOpenEscalations({ headers: {} }, { now: IN_WINDOW });
  const after = await R.getApprovals();
  assert.equal(after[0].status, "escalated", "reporting must not resolve anything");
  assert.equal(after[0].backupAskSent, true);
  assert.equal(after[0].backupSkippedStale, undefined, "must not touch the one-shot guard");
});

console.log("\n" + passed + "/" + passed + " passed");
