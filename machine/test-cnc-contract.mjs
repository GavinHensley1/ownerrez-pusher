import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const html = readFileSync(new URL("index.html", root), "utf8");
const api = readFileSync(new URL("api/app.js", root), "utf8");
const agent = readFileSync(new URL("machine/cnc-cloud-agent.mjs", root), "utf8");

test("CNC page script parses and exposes the guarded four-step controls", () => {
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).filter(Boolean);
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new Function(scripts[0]));
  for (const id of ["cncReadiness", "cncZeroBtn", "cncProbeBtn", "cncStartBtn", "cncPauseBtn", "cncResumeBtn", "cncStopBtn"]) assert.match(html, new RegExp(`id=["']${id}["']`));
  assert.doesNotMatch(html, /G38\.2/);
  assert.doesNotMatch(html, /rpm:\s*(?:10000|12000|24000)/);
});

test("Vercel queues commands for an authenticated outbound CNC agent", () => {
  assert.match(api, /action==="cnc_agent"/);
  assert.match(api, /process\.env\.CNC_AGENT_TOKEN/);
  assert.match(api, /parkside:cnc:command/);
  assert.match(api, /Virtual machine boundaries are not ready/);
  assert.doesNotMatch(api, /fetch\(murl/);
});

test("local bridge retrieves its token from Keychain and uses the Unix socket", () => {
  assert.match(agent, /find-generic-password/);
  assert.match(agent, /openclaw-cnc-agent/);
  assert.match(agent, /socketPath: SOCKET_PATH/);
  assert.doesNotMatch(agent, /console\.log\(token\)|process\.stdout\.write\(token/);
});
