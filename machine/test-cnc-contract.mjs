import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const html = readFileSync(new URL("index.html", root), "utf8");
const api = readFileSync(new URL("api/app.js", root), "utf8");
const agent = readFileSync(new URL("machine/cnc-cloud-agent.mjs", root), "utf8");
const daemon = readFileSync(new URL("machine/cnc-daemon.mjs", root), "utf8");

test("CNC page script parses and exposes guarded positioning and two-probe controls", () => {
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).filter(Boolean);
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new Function(scripts[0]));
  for (const id of ["cncReadiness", "cncJogStep", "cncZeroBtn", "cncProbeBedBtn", "cncProbeStockBtn", "cncProbeLockBtn", "cncStockZZeroBtn", "cncProbeUnlockBtn", "cncProbeRecoverBtn", "cncMeasuredStock", "cncOriginFootprint", "cncStartBtn", "cncPauseBtn", "cncResumeBtn", "cncStopBtn"]) assert.match(html, new RegExp(`id=["']${id}["']`));
  assert.match(html, /machineAction:'jog'/);
  assert.match(html, /<option value="100">100 mm<\/option>/);
  assert.match(html, /<option value="0\.1">0\.1 mm<\/option>/);
  assert.match(html, /Z is limited to 5 mm per click/);
  assert.match(html, /probe_bed/);
  assert.match(html, /probe_stock/);
  assert.match(html, /lock_probe/);
  assert.match(html, /unlock_probe/);
  assert.match(html, /zero_z/);
  assert.match(html, /Re-probe bed/);
  assert.match(html, /confirmReprobe/);
  assert.match(html, /Required carve footprint/);
  assert.match(html, /Stock fit/);
  assert.match(html, /Stock width X/);
  assert.match(html, /X\+ right/);
  assert.match(html, /Y\+ back/);
  assert.match(html, /recover_probe/);
  assert.match(html, /budget:30000/);
  assert.match(html, /cncGenReliefRegion\(img/);
  assert.match(html, /job\.reliefSource==='depth'&&job\.hasDepth/);
  assert.match(html, /artwork source/);
  assert.doesNotMatch(html, /G38\.2/);
  assert.doesNotMatch(html, /rpm:\s*(?:10000|12000|24000)/);
});

test("Vercel queues commands for an authenticated outbound CNC agent", () => {
  assert.match(api, /action==="cnc_agent"/);
  assert.match(api, /process\.env\.CNC_AGENT_TOKEN/);
  assert.match(api, /parkside:cnc:command/);
  assert.match(api, /Virtual machine boundaries are not ready/);
  assert.match(api, /Probe both the bed and stock before Start/);
  assert.match(api, /Lock the probe calibration before Start/);
  assert.match(api, /Explicit stock Z-zero confirmation is required/);
  assert.match(api, /complete toolpath does not fit inside the entered stock dimensions/);
  assert.match(api, /Explicit confirmation is required to replace the locked Z calibration/);
  assert.match(api, /cmd\.confirmReprobe=b\.confirmReprobe===true/);
  assert.match(api, /Jog step is outside the safe per-click limit/);
  assert.match(api, /const maxStep=axis==="Z"\?5:100/);
  assert.match(api, /Z jogs are limited to 5 mm per click/);
  assert.doesNotMatch(api, /fetch\(murl/);
});

test("local bridge retrieves its token from Keychain and uses the Unix socket", () => {
  assert.match(agent, /find-generic-password/);
  assert.match(agent, /openclaw-cnc-agent/);
  assert.match(agent, /socketPath: SOCKET_PATH/);
  assert.match(agent, /manualPositioning: true/);
  assert.match(agent, /splitJogDistance/);
  assert.match(agent, /completedSegments/);
  assert.match(agent, /stockWidthMm/);
  assert.match(agent, /recover_probe: "\/probe\/recover"/);
  assert.match(agent, /lock_probe: "\/probe\/lock"/);
  assert.match(agent, /unlock_probe: "\/probe\/unlock"/);
  assert.match(agent, /zero_z: "\/zero\/z"/);
  assert.match(agent, /confirmReprobe: command\.confirmReprobe === true/);
  assert.ok(agent.includes('const isHealth = path === "/health"'));
  assert.match(agent, /headers: isHealth \? \{\} :/);
  assert.match(agent, /if \(!isHealth\) req\.write\(data\)/);
  assert.doesNotMatch(agent, /console\.log\(token\)|process\.stdout\.write\(token/);
});

test("local daemon separates manual probe staging from the carve envelope", () => {
  assert.match(daemon, /negativeWorkspaceMarginMm/);
  assert.match(daemon, /new Set\(\["X", "Y"\]\)\.has\(axis\) \? 60 : 0/);
});

test("bed re-probe atomically replaces only the locked Z calibration", () => {
  assert.match(daemon, /kind !== "bed" \|\| payload\.confirmReprobe !== true/);
  assert.match(daemon, /removeProbeLock\(PROBE_STATE_PATH\);\s*clearProbeSetup\("reprobe_in_progress"\);\s*workspace\.clear\(\);/);
  assert.doesNotMatch(daemon, /removeXyLock\(XY_STATE_PATH\);\s*clearProbeSetup\("reprobe_in_progress"\)/);
});
