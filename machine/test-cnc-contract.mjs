import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const html = readFileSync(new URL("index.html", root), "utf8");
const api = readFileSync(new URL("api/app.js", root), "utf8");
const agent = readFileSync(new URL("machine/cnc-cloud-agent.mjs", root), "utf8");

test("CNC page script parses and exposes guarded positioning and two-probe controls", () => {
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).filter(Boolean);
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new Function(scripts[0]));
  for (const id of ["cncReadiness", "cncJogStep", "cncZeroBtn", "cncProbeBedBtn", "cncProbeStockBtn", "cncMeasuredStock", "cncStartBtn", "cncPauseBtn", "cncResumeBtn", "cncStopBtn"]) assert.match(html, new RegExp(`id=["']${id}["']`));
  assert.match(html, /machineAction:'jog'/);
  assert.match(html, /<option value="100">100 mm<\/option>/);
  assert.match(html, /probe_bed/);
  assert.match(html, /probe_stock/);
  assert.doesNotMatch(html, /G38\.2/);
  assert.doesNotMatch(html, /rpm:\s*(?:10000|12000|24000)/);
});

test("Vercel queues commands for an authenticated outbound CNC agent", () => {
  assert.match(api, /action==="cnc_agent"/);
  assert.match(api, /process\.env\.CNC_AGENT_TOKEN/);
  assert.match(api, /parkside:cnc:command/);
  assert.match(api, /Virtual machine boundaries are not ready/);
  assert.match(api, /Probe both the bed and stock before Start/);
  assert.match(api, /Jog step is outside the safe per-click limit/);
  assert.match(api, /const maxStep=100/);
  assert.doesNotMatch(api, /fetch\(murl/);
});

test("local bridge retrieves its token from Keychain and uses the Unix socket", () => {
  assert.match(agent, /find-generic-password/);
  assert.match(agent, /openclaw-cnc-agent/);
  assert.match(agent, /socketPath: SOCKET_PATH/);
  assert.match(agent, /manualPositioning: true/);
  assert.match(agent, /splitJogDistance/);
  assert.match(agent, /completedSegments/);
  assert.ok(agent.includes('const isHealth = path === "/health"'));
  assert.match(agent, /headers: isHealth \? \{\} :/);
  assert.match(agent, /if \(!isHealth\) req\.write\(data\)/);
  assert.doesNotMatch(agent, /console\.log\(token\)|process\.stdout\.write\(token/);
});
