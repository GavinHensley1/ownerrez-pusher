// Offline operator-path regression: the real browser handlers dispatch to the
// real API queue and daemon, which speak to in-memory Redis and fake GRBL.
// The cloud transport is substituted, not the actual API acceptance gates.
// No live machine, production socket, persistent state, or localhost:47832 use.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const waitFor = async (predicate, timeout = 8000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw Error('Timed out waiting for isolated daemon');
};
const request = (socketPath, path, body) => new Promise((resolve, reject) => {
  const encoded = body === undefined ? '' : JSON.stringify(body);
  const req = http.request({ socketPath, path, method: body === undefined ? 'GET' : 'POST', headers: encoded ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded) } : {} }, res => {
    let text = ''; res.setEncoding('utf8'); res.on('data', chunk => text += chunk);
    res.on('end', () => { try { resolve({ status: res.statusCode, value: JSON.parse(text) }); } catch (e) { reject(e); } });
  });
  req.setTimeout(15000, () => req.destroy(Error('Isolated request timed out')));
  req.on('error', reject); req.end(encoded);
});

async function fakeController() {
  const position = { X: 10, Y: 10, Z: -22 }, commands = [], sockets = new Set();
  let state = 'Hold:0', pins = 'PZ', hardLimits = 1, rejectNextSettings = false;
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); let buffer = '';
    socket.on('data', bytes => {
      for (const byte of bytes) {
        const char = String.fromCharCode(byte);
        if (char === '?') { socket.write(`<${state}|MPos:${position.X.toFixed(3)},${position.Y.toFixed(3)},${position.Z.toFixed(3)}|FS:0,0${pins ? '|Pn:' + pins : ''}>\r\n`); continue; }
        if (byte === 0x18) { commands.push('RESET'); state = 'Alarm'; socket.write("Grbl 1.1h ['$' for help]\r\n"); continue; }
        if (char === '~') { commands.push('CYCLE_START'); continue; }
        if (char === '!') { commands.push('FEED_HOLD'); state = 'Hold:0'; continue; }
        if (byte === 0x85 || byte === 0x9e) continue;
        buffer += char; if (char !== '\r') continue;
        const command = buffer.trim(); buffer = ''; commands.push(command);
        if (command === '$$') {
          if (rejectNextSettings) { rejectNextSettings = false; socket.write('error:2\r\n'); continue; }
          // A real observed bridge bug: a stale acknowledgment precedes the
          // requested setting payload. The current request must wait for $21.
          socket.write('ok\r\n');
          setTimeout(() => { if (!socket.destroyed) socket.write(`$13=0\r\n$20=0\r\n$21=${hardLimits}\r\n$100=800\r\n$101=800\r\n$102=800\r\n$130=400\r\n$131=400\r\n$132=80\r\nok\r\n`); }, 10);
        } else if (command === '$X') { state = 'Idle'; socket.write('ok\r\n'); }
        else if (/^\$21=[01]$/.test(command)) { hardLimits = Number(command.at(-1)); socket.write('ok\r\n'); }
        else if (command === '$#') socket.write('[G54:0,0,0]\r\n[G92:0,0,0]\r\n[TLO:0]\r\n[PRB:10,10,-22:1]\r\nok\r\n');
        else if (command === '$G') socket.write('[GC:G0 G54 G17 G21 G90 G94 M5 M9 T0 F0 S0]\r\nok\r\n');
        else if (command.startsWith('$J=')) {
          if (hardLimits && pins.includes('Z')) { state = 'Alarm'; socket.write('ALARM:1\r\n'); continue; }
          for (const axis of ['X', 'Y', 'Z']) { const match = command.match(new RegExp(axis + '(-?\\d+(?:\\.\\d+)?)')); if (match) position[axis] += Number(match[1]); }
          pins = ''; state = 'Idle'; socket.write('ok\r\n');
        } else socket.write('ok\r\n');
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, commands, position, rejectSettings() { rejectNextSettings = true; }, snapshot: () => ({ state, pins, hardLimits }), close: async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}

async function operatorHarness() {
  // Expose existing browser handlers without altering application or harness
  // files. Their confirmation, state checks and payload construction stay real.
  const source = readFileSync(new URL('./cnc-browser-harness.mjs', import.meta.url), 'utf8').replace(
    'return { cncRenderToolpath,',
    'return { operatorHooks(send) { cncQueueMachineAction = send; confirm = () => true; return { recover: cncRecoverProbe, jog: cncJog }; }, cncRenderToolpath,'
  );
  const module = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  return module.loadBrowserScript(new URL('../index.html', import.meta.url).pathname);
}

function apiHarness() {
  const values = new Map(), requireActual = createRequire(new URL('../api/app.js', import.meta.url));
  class Redis { async get(key) { return values.get(key); } async set(key, value) { values.set(key, value); return 'OK'; } async del(key) { values.delete(key); return 1; } }
  const context = vm.createContext({ module: { exports: {} }, Buffer, URLSearchParams, process: { env: { APP_PASSWORD: 'offline-only-fixture' } },
    require(id) { return id === '@upstash/redis' ? { Redis } : requireActual(id); },
    fetch() { throw Error('External network forbidden in operator regression'); },
  });
  vm.runInContext(readFileSync(new URL('../api/app.js', import.meta.url), 'utf8'), context, { filename: 'api/app.js' });
  return async (job, config, health, action, extra = {}) => {
    values.clear();
    values.set('parkside:cnc', JSON.stringify({ jobs: [job], config }));
    values.set('parkside:cnc:agent', JSON.stringify({ at: new Date().toISOString(), health }));
    const response = { statusCode: 200, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.value = value; return this; } };
    await context.module.exports({ method: 'POST', query: { action: 'cnc' }, headers: { 'x-app-password': 'offline-only-fixture' }, body: { jobId: job.id, machineAction: action, ...extra } }, response);
    const queued = values.get('parkside:cnc:command');
    return { status: response.statusCode, value: response.value, command: queued ? JSON.parse(queued) : null };
  };
}

test('real API permits uncalibrated manual setup independently of frame-recovery state but rejects automatic cuts', async () => {
  const api = apiHarness(), job = { id: 'offline-api', material: 'Hard maple', hasGcode: true, agentState: 'idle' }, config = { machX: 300, machY: 200 };
  const health = { connected: true, frameValid: false, frameRecovery: { active: false }, moving: false, workspace: { calibrated: false }, setup: { xyReady: false, probeLocked: false }, job: { state: 'idle' }, lastControllerStatus: { state: 'Hold:0', MPos: '10,10,-22', FS: '0,0', Pn: 'PZ' } };
  const recovered = await api(job, config, health, 'recover_probe');
  assert.equal(recovered.status, 200, JSON.stringify(recovered.value));
  assert.equal(recovered.command.action, 'recover_probe');
  health.lastControllerStatus = { state: 'Idle', MPos: '10,10,-19', FS: '0,0' };
  for (const axis of ['X', 'Y', 'Z']) {
    const moved = await api(job, config, health, 'jog', { axis, distanceMm: 1, feedMmPerMin: 100 });
    assert.equal(moved.status, 200, `${axis}: ${JSON.stringify(moved.value)}`);
    assert.equal(moved.command.axis, axis);
  }
  const cut = await api(job, config, health, 'start');
  assert.equal(cut.status, 409);
  assert.equal(cut.command, null, 'no automatic cut enters the queue');
});

for (const calibration of ['missing', 'invalid', 'saved-material']) test(`operator recovers Hold:PZ with ${calibration} calibration, then completes XYZ positioning without releasing Start`, { timeout: 30000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'cnc-operator-contact-')), socketPath = join(dir, 'daemon.sock'), grbl = await fakeController();
  const env = { ...process.env, CNC_HOST: '127.0.0.1', CNC_PORT: String(grbl.port), CNC_DAEMON_SOCKET: socketPath, CNC_LOCAL_UI_PORT: '0' };
  for (const [key, name] of Object.entries({ CNC_PROBE_STATE: 'probe', CNC_MATERIAL_STATE: 'material', CNC_XY_STATE: 'xy', CNC_PROGRAM_STATE: 'program', CNC_RUN_STATE: 'run', CNC_EVENT_JOURNAL: 'events', CNC_FRAME_INCIDENT: 'frame', CNC_PLATE_CONFIG: 'plate', CNC_CONTROLLER_SETTINGS: 'settings' })) env[key] = join(dir, name + '.json');
  writeFileSync(env.CNC_FRAME_INCIDENT, JSON.stringify({ latched: true, reason: 'SAVED_COORDINATE_CONTINUITY_UNVERIFIED', duringMotion: false }));
  if (calibration === 'invalid') for (const key of ['CNC_PROBE_STATE', 'CNC_XY_STATE', 'CNC_MATERIAL_STATE']) writeFileSync(env[key], '{}');
  const savedMaterial = JSON.stringify({ version: 1, stockThicknessMm: 10, safetyFloorMm: 0.8, maxCutDepthMm: 9.2, capturedAt: new Date().toISOString(), source: 'Isolated regression fixture' });
  if (calibration === 'saved-material') writeFileSync(env.CNC_MATERIAL_STATE, savedMaterial);
  const child = spawn(process.execPath, [new URL('./cnc-daemon.mjs', import.meta.url).pathname], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', b => log += b); child.stderr.on('data', b => log += b);
  t.after(async () => { if (child.exitCode === null) { const ended = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await ended; } await grbl.close(); });
  await waitFor(() => existsSync(socketPath));
  await waitFor(async () => { const h = (await request(socketPath, '/health')).value; return h.connected && !h.moving && !h.reconnecting; });
  const browser = await operatorHarness(), job = { id: 'offline-operator', sizeMM: 30, pieceH: 20, material: 'Hard maple', reliefDepth: 0.8, hasGcode: true, agentState: 'idle' }, config = { machX: 300, machY: 200, machZ: 40, machMargin: 5 };
  const render = async () => { const h = (await request(socketPath, '/health')).value; const rendered = browser.renderAgent(job, h, config); return { health: h, ...rendered }; };
  const api = apiHarness(), dispatched = [], handlers = browser.operatorHooks(async (action, payload = {}) => {
    dispatched.push({ action, payload });
    const health = (await request(socketPath, '/health')).value;
    const accepted = await api(job, config, health, action, payload);
    assert.equal(accepted.status, 200, `real API: ${JSON.stringify(accepted.value)}`);
    assert.equal(accepted.command.action, action);
    payload = accepted.command;
    const route = action === 'recover_probe' ? '/probe/recover' : '/jog/' + payload.axis.toLowerCase();
    const result = await request(socketPath, route, { ...payload, ...(action === 'jog' ? { manualPositioning: true, stockWidthMm: 300, stockHeightMm: 200 } : {}) });
    assert.equal(result.status, 200, `${action}: ${JSON.stringify(result.value)}\n${log}`);
    return result.value;
  });
  let rendered = await render();
  assert.equal(rendered.health.lastControllerStatus.state, 'Hold:0');
  assert.equal(rendered.health.lastControllerStatus.Pn, 'PZ');
  assert.equal(browser.elements.cncProbeRecoverBtn.disabled, false, 'real recovery control must be reachable despite an unverified frame');
  assert.equal(rendered.start.disabled, true);
  if (calibration === 'saved-material') assert.equal(rendered.health.setup.materialReady, true, 'fixture starts with restored material readiness');
  // A failed read must be retryable from the actual control, without a new
  // feed-hold trap or any unrequested move.
  grbl.rejectSettings();
  await assert.rejects(handlers.recover(browser.elements.cncProbeRecoverBtn), /error:2|GRBL|setting/i);
  assert.equal(grbl.position.Z, -22);
  assert.equal(grbl.commands.includes('FEED_HOLD'), false, 'a pre-motion settings rejection must not create a new Hold trap');
  rendered = await render();
  assert.equal(rendered.health.setup.materialReady, false, 'reset invalidates pre-reset readiness even when the later settings read rejects');
  assert.equal(rendered.health.setup.probeLocked, false);
  assert.equal(rendered.health.controllerProtection.ready, false);
  assert.equal(rendered.health.frameValid, false);
  const journal = readFileSync(env.CNC_EVENT_JOURNAL, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(journal.filter(e => e.type === 'probe.recovery_reset_acknowledged').length, 1, 'daemon records acknowledgment before the rejected read completes');
  assert.equal(browser.elements.cncProbeRecoverBtn.disabled, false, 'recovery remains reachable after the failed request');
  const zUp = browser.jogButtons.find(b => b.dataset.axis === 'Z' && b.dataset.dir === '1');
  assert.equal(zUp.disabled, false, 'Z+ is also a reachable recovery path');
  const result = calibration === 'invalid' ? await handlers.jog('Z', 1, zUp) : await handlers.recover(browser.elements.cncProbeRecoverBtn);
  assert.equal(result.after.state, 'Idle');
  assert.equal(grbl.position.Z, -19, 'completed Z+3, not merely an enabled button');
  assert.deepEqual(grbl.snapshot(), { state: 'Idle', pins: '', hardLimits: 1 });
  assert.equal(grbl.commands.filter(c => c === 'RESET').length, 1, 'held planner was explicitly discarded once');
  assert.equal(grbl.commands.includes('CYCLE_START'), false, 'recovery must never resume an old buffer');
  assert.equal(grbl.commands.some(c => c.startsWith('G10')), false, 'recovery must not overwrite saved zeros');
  for (const axis of ['X', 'Y', 'Z']) {
    rendered = await render(); browser.elements.cncJogStep.value = '1';
    const button = browser.jogButtons.find(b => b.dataset.axis === axis && b.dataset.dir === '1');
    assert.equal(button.disabled, false, `${axis}+ must be reachable with no saved calibration`);
    const before = grbl.position[axis]; await handlers.jog(axis, 1, button);
    assert.equal(grbl.position[axis], before + 1, `${axis}+ actually completed`);
  }
  rendered = await render();
  assert.equal(rendered.start.disabled, true, 'manual recovery does not release automatic cutting');
  const cut = await request(socketPath, '/job/start', { jobId: job.id, gcode: 'G21\nG90\nG1 X20 F100\nM30', manualRouter: true, stockWidthMm: 300, stockHeightMm: 200 });
  assert.equal(cut.status, 500, 'daemon independently rejects uncalibrated automatic cutting');
  assert.equal(dispatched.filter(c => c.action === 'jog').length, 3);
  if (calibration === 'invalid') for (const key of ['CNC_PROBE_STATE', 'CNC_XY_STATE', 'CNC_MATERIAL_STATE']) assert.equal(readFileSync(env[key], 'utf8'), '{}', 'stored calibration evidence is retained');
  if (calibration === 'saved-material') assert.equal(readFileSync(env.CNC_MATERIAL_STATE, 'utf8'), savedMaterial, 'reset invalidates readiness, not the saved material record');
});
