import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { GrblTcpController } from './cnc-controller.mjs';

async function fixture(t, { initialState = 'Hold:0', initialPins = 'PZ', settingsError = false, omitSetting = false, ignoreLimitSuppression = false } = {}) {
  let state = initialState, pins = initialPins, z = -16.965, hardLimits = true;
  let planner = ['G1 X100 Z-50'], partialRx = 'G1 X250', resetCount = 0;
  const wire = [], guards = [], sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    socket.on('data', chunk => {
      for (const byte of chunk) {
        const char = String.fromCharCode(byte);
        if (char === '?') { wire.push('?'); socket.write(`<${state}|MPos:0.000,-134.000,${z.toFixed(3)}|FS:0,0${pins ? `|Pn:${pins}` : ''}>\r\n`); continue; }
        if (byte === 0x18) { wire.push('reset'); planner = []; partialRx = ''; buffer = ''; resetCount++; state = 'Alarm'; socket.write("Grbl 1.1h ['$' for help]\r\nok\r\n"); continue; }
        if (char === '~') { wire.push('~'); state = 'Run'; z = -50; continue; }
        if (char === '!' || byte === 0x85 || byte === 0x9e) { wire.push(`realtime:${byte}`); state = 'Hold:0'; continue; }
        buffer += char;
        if (char !== '\r') continue;
        const command = buffer.trim(); buffer = ''; wire.push(command);
        if (state === 'Hold:0') { partialRx += command; continue; }
        if (command === 'M5' && state === 'Alarm') { socket.write('error:9\r\n'); setTimeout(() => { if (!socket.destroyed) socket.write('ok\r\n'); }, 5); continue; }
        if (command === '$X') { state = 'Idle'; socket.write('ok\r\n'); continue; }
        if (command === '$$') {
          if (settingsError || state === 'Alarm') { socket.write('error:9\r\n'); continue; }
          // Reproduce a bridge's unpaired ok arriving before the $$ payload.
          socket.write('ok\r\n');
          setTimeout(() => { if (!socket.destroyed) socket.write(`$13=0\r\n${omitSetting ? '' : `$21=${hardLimits ? 1 : 0}\r\n`}$27=3.000\r\nok\r\n`); }, 10);
          continue;
        }
        if (command === '$21=0' || command === '$21=1') { if (!ignoreLimitSuppression || command === '$21=1') hardLimits = command.endsWith('1'); socket.write('ok\r\n'); continue; }
        if (command.startsWith('$J=')) {
          if (hardLimits && pins.includes('Z')) { state = 'Alarm'; socket.write('ALARM:1\r\n'); continue; }
          z += Number(command.match(/Z([-+0-9.]+)/)?.[1] || 0); pins = ''; state = 'Idle'; socket.write('ok\r\n'); continue;
        }
        socket.write('ok\r\n');
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const controller = new GrblTcpController({ host: '127.0.0.1', port: server.address().port, statusTimeoutMs: 20, commandTimeoutMs: 100, motionGuard: async context => {
    guards.push(context); assert(context?.allowProbeRecovery || context?.allowManualPositioning, 'explicit operator recovery does not require the saved cutting frame');
  } });
  t.after(async () => { await controller.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return { controller, wire, guards, setSettingsError: value => { settingsError = value; }, state: () => ({ state, pins, z, hardLimits, planner, partialRx, resetCount }) };
}

for (const initialState of ['Hold:0', 'Alarm', 'Idle']) test(`probe contact retract works from ${initialState} despite late duplicate ok and unverified saved frame`, async t => {
  const f = await fixture(t, { initialState });
  const result = await f.controller.recoverProbeContact();
  assert.equal(result.after.state, 'Idle'); assert.equal(result.after.Pn, undefined);
  assert.equal(result.retract.deltaMm, 3); assert.equal(result.hardLimitsRestored, true);
  assert.equal(result.discardedBufferedMotion, initialState === 'Hold:0');
  assert.equal(f.state().z, -13.965); assert(f.state().hardLimits);
  assert(!f.wire.includes('~')); assert(!f.wire.includes('M5')); assert(!f.wire.some(line => line.startsWith('G10')));
  assert.equal(f.wire.filter(line => line.startsWith('$J=')).length, 1);
  assert.equal(f.wire.find(line => line.startsWith('$J=')), '$J=G91 G21 Z3.000 F100');
  assert(f.guards.every(context => context.allowProbeRecovery));
  if (initialState === 'Hold:0') {
    assert.deepEqual(f.state().planner, []); assert.equal(f.state().partialRx, '');
    assert(f.wire.indexOf('reset') < f.wire.indexOf('$X'));
    assert(f.wire.indexOf('$X') < f.wire.indexOf('$$'));
  }
});

test('settings rejection before motion does not introduce another Hold trap', async t => {
  const f = await fixture(t, { initialState: 'Alarm', settingsError: true });
  await assert.rejects(() => f.controller.recoverProbeContact(), /error:9/);
  assert.equal(f.state().state, 'Idle'); assert.equal(f.state().z, -16.965);
  assert(!f.wire.some(line => line.startsWith('$J=') || line.startsWith('realtime:')));
});

test('missing setting is never replaced with a fabricated default', async t => {
  const f = await fixture(t, { initialState: 'Alarm', omitSetting: true });
  await assert.rejects(() => f.controller.recoverProbeContact(), /response timeout/);
  assert(!f.wire.includes('$21=0')); assert(!f.wire.some(line => line.startsWith('$J=')));
});

test('limit suppression must be read back before upward motion', async t => {
  const f = await fixture(t, { initialState: 'Alarm', ignoreLimitSuppression: true });
  await assert.rejects(() => f.controller.recoverProbeContact(), /did not enter/);
  assert(!f.wire.some(line => line.startsWith('$J='))); assert.equal(f.state().hardLimits, true);
});

test('ordinary manual retract carries manual positioning context through every guard', async t => {
  const f = await fixture(t, { initialState: 'Idle', initialPins: '' });
  const result = await f.controller.jog('Z', 1, 100, { safeRetract: true });
  assert.equal(result.deltaMm, 1); assert(f.guards.every(context => context.allowManualPositioning));
});

for (const initialState of ['Hold:1', 'Run', 'Door:0']) test(`probe recovery does not reset or retract an unsuitable ${initialState} state`, async t => {
  const f = await fixture(t, { initialState });
  await assert.rejects(() => f.controller.recoverProbeContact(), /requires stopped/);
  assert.deepEqual(f.wire, ['?']);
});


test('reset readiness invalidation is emitted before a later settings failure and survives Idle retry', async t => {
  const f = await fixture(t, { settingsError: true });
  const resets = [];
  let setupReady = true;
  f.controller.on('probeRecoveryReset', event => {
    resets.push(event); setupReady = false;
    assert(!f.wire.includes('$$'), 'owner learns reset before a fallible settings query');
  });
  await assert.rejects(() => f.controller.recoverProbeContact(), /error:9/);
  assert.equal(resets.length, 1); assert.equal(resets[0].before.state, 'Hold:0');
  assert.match(resets[0].resetWelcome, /^Grbl/);
  assert.equal(setupReady, false); assert.equal(f.state().state, 'Idle');
  f.setSettingsError(false);
  const retried = await f.controller.recoverProbeContact();
  assert.equal(retried.after.state, 'Idle'); assert.equal(retried.discardedBufferedMotion, false);
  assert.equal(resets.length, 1); assert.equal(f.state().resetCount, 1); assert.equal(setupReady, false);
});
