import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const html = readFileSync(new URL("index.html", root), "utf8");
const api = readFileSync(new URL("api/app.js", root), "utf8");
const agent = readFileSync(new URL("machine/cnc-cloud-agent.mjs", root), "utf8");
const codec = readFileSync(new URL("machine/cnc-program-codec.mjs", root), "utf8");
const daemon = readFileSync(new URL("machine/cnc-daemon.mjs", root), "utf8");
const controller = readFileSync(new URL("machine/cnc-controller.mjs", root), "utf8");
const program = readFileSync(new URL("machine/cnc-program.mjs", root), "utf8");

function extractNamedFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

test("CNC page script parses and exposes guarded positioning, automatic material save, and tool touch-off", () => {
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).filter(Boolean);
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new Function(scripts[0]));
  for (const id of ["cncCommandPanel", "cncCommandTitle", "cncCommandDetail", "cncControllerReadout", "cncReadiness", "cncJogStep", "cncZeroBtn", "cncRestoreXyBtn", "cncProbeBedBtn", "cncProbeStockBtn", "cncProbeToolBtn", "cncProbeLockBtn", "cncStockZZeroBtn", "cncProbeUnlockBtn", "cncProbeRecoverBtn", "cncControllerRecoverBtn", "cncMeasuredStock", "cncOriginFootprint", "cncPlanOffsetX", "cncPlanOffsetY", "cncStartBtn", "cncPauseBtn", "cncResumeBtn", "cncStopBtn"]) assert.match(html, new RegExp(`id=["']${id}["']`));
  assert.match(html, /cncQueueMachineAction\('jog'/);
  assert.match(html, /if\(action==='jog'\)return 'Move'/);
  assert.match(html, /One press sends one command/);
  assert.match(html, /aria-live="assertive"/);
  assert.match(html, /zero\.disabled=motionBlocked/);
  assert.match(html, /recoverProbe\.disabled=motionBlocked/);
  assert.match(html, /function cncControllerState/);
  assert.match(html, /Controller ready/);
  assert.match(html, /Positioning paused/);
  assert.match(html, /Enable positioning/);
  assert.match(html, /Restore saved X\/Y/);
  assert.match(html, /Set current point as X0\/Y0/);
  assert.match(html, /setupActions=\['jog','probe_bed','probe_stock','probe_tool'/);
  assert.match(html, /cncCurrentJob\(\)\|\|await cncEnsureJob\(\)/);
  assert.match(html, /confirmNewProject:true/);
  assert.match(html, /confirmGantryUnmoved/);
  assert.match(html, /external router does not need to be installed/i);
  assert.match(html, /button\.disabled=!!baseBlocked/);
  assert.match(html, /Controller stopped · recovery required/);
  assert.match(html, /function cncResume/);
  assert.match(html, /resume_saved/);
  assert.match(html, /Restart stage from beginning/);
  assert.match(html, /RESTART FROM LINE 1/);
  assert.match(html, /Fixed 20 millimeter Genmitsu probe puck/);
  assert.doesNotMatch(html, /value="12\.1"/);
  assert.match(html, /var motionBlocked=baseBlocked\|\|!controller\.idle/);
  assert.match(html, /<option value="100">100 mm<\/option>/);
  assert.match(html, /<option value="0\.1">0\.1 mm<\/option>/);
  assert.match(html, /Z is limited to 5 mm per click/);
  assert.match(html, /probe_bed/);
  assert.doesNotMatch(html, /test_probe|NO-MOTION PROBE TEST|Test probe circuit/);
  assert.match(html, /probe_stock/);
  assert.match(html, /probe_tool/);
  assert.match(html, /detail\?tools\.detailBit/);
  assert.match(html, /current\.activeStage!==previousStage/);
  assert.match(html, /first_retract/);
  assert.match(html, /lock_probe/);
  assert.match(html, /unlock_probe/);
  assert.match(html, /zero_z/);
  assert.match(html, /Re-measure bed/);
  assert.match(html, /confirmReprobe/);
  assert.match(html, /Required carve footprint/);
  assert.match(html, /Stock fit/);
  assert.match(html, /Stock width X/);
  assert.match(html, /X\+ right/);
  assert.match(html, /Y\+ back/);
  assert.match(html, /recover_probe/);
  assert.match(html, /budget:\(stage==='finish'\?700000:\(stage==='detail'\?180000:\(stage==='rough'&&metal\?700000:30000\)\)\)/);
  assert.match(html, /async function cncGenFromImage[\s\S]*?metal=cncIsMetalJob\(job\)\|\|\(plan&&plan\.reliefMode==='raised-surface'\)/);
  assert.match(html, /function cncPlanContinuousDepth/);
  assert.match(html, /RELIEF MODE:/);
  assert.match(html, /continuous piecewise-linear depth/);
  assert.match(html, /function cncMinimumFeatureMm/);
  assert.match(html, /minimum feature/);
  assert.match(html, /function cncCompensateToolpath/);
  assert.match(html, /function cncOffsetProgram/);
  assert.match(html, /endX=f\.OX\+f\.W,endY=f\.OY\+f\.H/);
  assert.match(html, /TOOL COMPENSATION:/);
  assert.match(html, /stockToLeaveMm:rough\?\(Number\(t\.roughStockToLeaveMm\)\|\|\.5\):0/);
  assert.match(html, /function cncFinishFidelity/);
  assert.match(html, /function cncAppendDetailContours/);
  assert.match(html, /Number\(p\.version\)!==5/);
  assert.match(html, /Prepare raised-metal copy/);
  assert.match(html, /C752 nickel silver/);
  assert.match(html, /Whiteside RU2100 · 1\/4″ solid-carbide upcut · 1\/4″ shank · 2 cutting edges/);
  assert.match(html, /Genmitsu MC40A · 3\.175mm 2-flute ball nose · dark case/);
  assert.match(html, /reliefMode:metal\?'raised-surface':'standard'/);
  assert.match(html, /RELIEF CONTRACT: raised artwork remains at stock Z0/);
  assert.match(html, /ENTRY POLICY:/);
  assert.match(html, /TRAVEL POLICY: all XY rapids at safe Z; vertical retract before exit/);
  assert.match(html, /function cncAssertRaisedMetalSafety/);
  assert.match(html, /function cncAssertRu2100RoughSafety/);
  assert.match(html, /function cncAssertRu2100ProfileSafety/);
  assert.match(html, /RU2100 CONSERVATIVE CONTRACT/);
  assert.match(html, /roughPassDepthMm:\.025/);
  assert.match(html, /roughStepoverMm:\.8/);
  assert.match(html, /roughFeedMmMin:400/);
  assert.match(html, /roughRampLengthMm:20/);
  assert.match(html, /function cncFitTwoBuckles/);
  assert.match(html, /Center first of two buckles on this stock/);
  assert.match(html, /reserved second buckle/);
  assert.match(api, /prepareMetalJob/);
  assert.match(api, /Artwork only; probe, origin, depth, G-code, and checkpoints were intentionally not copied/);
  assert.match(html, /function cncDetailFidelity/);
  assert.match(html, /function cncAssertDetailFidelity/);
  assert.match(html, /Three-bit relief \+ detail/);
  assert.match(html, /30° V-bit 0\.1mm/);
  assert.match(html, /DETAIL SAFETY: recessed grooves only/);
  assert.match(html, /uniqueDepths<128/);
  assert.match(html, /gcodeStagesGzip/);
  assert.match(html, /CompressionStream\('gzip'\)/);
  assert.match(html, /cncGenReliefRegion\(img/);
  assert.match(html, /id="cncPlanModal"/);
  assert.match(html, /const v=document\.getElementById\('pw'\)\.value;/);
  assert.match(html, /Approve plan &amp; generate G-code/);
  assert.match(html, /Save draft plan/);
  assert.match(html, /function cncPlanBuildMask/);
  assert.match(html, /smooth neutral-gray/);
  assert.match(html, /p\.chroma<=4&&p\.lum>=135&&local<=8/);
  assert.match(html, /function cncPlanMaskTouchesEdge/);
  assert.match(html, /The detected subject touches the image edge/);
  assert.match(html, /sample that exact mask into every machining grid/);
  assert.match(html, /sourceMask=cncPlanBuildMask/);
  assert.match(html, /Detected subject touches the image edge/);
  assert.match(html, /var startX=pts\[0\]\[0\], startY=pts\[0\]\[1\]/);
  assert.doesNotMatch(html, /'G0 X'\+x0\.toFixed\(3\)\+' Y'\+y0\.toFixed\(3\)/);
  assert.match(html, /function rowRuns\(py,ltr,belowSurfaceOnly\)/);
  assert.match(html, /roughRuns=rowRuns/);
  assert.match(html, /finishRuns=rowRuns/);
  assert.match(html, /function cncAddDepthRegion/);
  assert.match(html, /function cncApprovePlanAndGenerate/);
  assert.match(html, /function cncSavePlanDraft/);
  assert.match(html, /Draft saved with this project’s X\/Y and probe snapshot\. No G-code was created and no machine command was sent\./);
  assert.match(html, /job\.planStatus!=='approved'/);
  assert.match(html, /Cyan · surface \/ highest/);
  assert.match(html, /Gold · shallow detail/);
  assert.match(html, /Orange · medium detail/);
  assert.match(html, /Red · deepest detail/);
  assert.match(html, /Buckle edge · automatic/);
  assert.match(html, /Profile depth · automatic/);
  assert.match(html, /through-cut into sacrificial backing/);
  assert.match(html, /profileDepth=through&&locked/);
  assert.match(html, /profilePassDepthMm=metal&&\/RU2100\/i\.test/);
  assert.doesNotMatch(html, /id="cncPlanMask"/);
  assert.doesNotMatch(html, /id="cncPlanCutThick"/);
  assert.match(html, /function cncPreviewStage/);
  assert.match(html, /exact G-code depth/);
  assert.match(html, /haveX=false,haveY=false/);
  assert.match(html, /if\(hadXY\)upd\(px,py\);upd\(nx,ny\)/);
  assert.match(html, /FULL-STOCK PLACEMENT/);
  assert.match(html, /Exact motion bounds:/);
  assert.match(html, /prev\.style\.display='block'/);
  assert.match(html, /Previewing does not load or arm the stage/);
  assert.match(html, /function cncStartFrameCheck/);
  assert.match(html, /function cncPresentationState/);
  assert.match(html, /previous command error is historical/i);
  assert.match(html, /use the visible Project controls to retry/i);
  assert.match(html, /healthAt-jobAt>=15000/);
  assert.match(html, /class="cnc-preview-grid"/);
  assert.match(html, /\.cnc-preview-grid\{grid-template-columns:1fr!important\}/);
  assert.match(html, /\.cnc-stage\{flex-wrap:wrap;min-width:0\}/);
  assert.match(html, /Start position/);
  assert.match(html, /There is no upper Z ceiling/);
  assert.match(html, /axis!==['"]Z['"]/);
  assert.match(daemon, /axis !== "Z" && Number\.isFinite\(allowed\.max\)/);
  assert.match(html, /Whiteside RU2100/);
  assert.match(html, /SpeTool W01015-SPE-X/);
  assert.match(html, /id="cncPlanRoughPass"/);
  assert.match(html, /id="cncPlanFinishStep"/);
  assert.match(html, /roughRpm:18000/);
  assert.match(html, /finishRpm:18000/);
  assert.match(html, /gear 4/);
  assert.match(html, /manualRouter:!!plan/);
  assert.match(html, /if\(!manualRouter\)g\.push\('M3 S'/);
  assert.match(html, /if\(!manualRouter\)g\.push\('M5'/);
  assert.match(html, /Project cannot start or stop this AC router/);
  assert.match(html, /Switch it off manually after completion or any Stop/);
  assert.doesNotMatch(html, /artwork source/);
  assert.doesNotMatch(html, /G38\.2/);
  assert.doesNotMatch(html, /rpm:\s*(?:10000|12000|24000)/);
});

test("raised-metal safety gate rejects surface cutting and below-surface XY rapids", () => {
  assert.match(html, /targ\(px,py\)<-\.005&&safelyInside\(px,py\)/);
  const source = extractNamedFunction(html, "cncAssertRaisedMetalSafety");
  const check = new Function(`${source}; return cncAssertRaisedMetalSafety;`)();
  const contract = [
    "; RELIEF CONTRACT: raised artwork remains at stock Z0",
    "; ENTRY POLICY: approved interior entry",
    "; TRAVEL POLICY: all XY rapids at safe Z; vertical retract before exit",
  ];
  assert.doesNotThrow(() => check([...contract, "G21", "G90", "G4 P2", "G0 X1.000 Y1.000", "; RAMP ENTRY approach Z0.5000 target Z-0.1000 over 20.000 mm", "G1 Z0.5000 F40", "G1 X6.000 Y1.000 Z0.3500 F180", "G1 X11.000 Y1.000 Z0.2000", "G1 X16.000 Y1.000 Z0.0500", "G1 X21.000 Y1.000 Z-0.1000", "G0 Z3.000", "G0 X0 Y0"].join("\n")));
  assert.throws(() => check([...contract, "G0 Z3.000", "G0 X1.000 Y1.000", "; RAMP ENTRY approach Z0.5000 target Z-0.0250 over 20.000 mm", "G1 Z0.5000 F80", "G1 X21.000 Z-0.0250 F300"].join("\n")), /first axis motion must be XY/);
  assert.throws(() => check([...contract, "G0 X1.000 Y1.000", "; RAMP ENTRY approach Z0.5000 target Z-0.0250 over 20.000 mm", "G1 Z-0.0100 F80", "G1 X21.000 Z-0.0250 F300"].join("\n")), /vertical entry reaches the metal surface/);
  assert.doesNotThrow(() => check([...contract, "G0 X1.000 Y1.000", "; RAMP ENTRY approach Z0.5000 target Z-0.1000 over 20.000 mm", "G1 Z0.5000 F40", "G1 X11.000 Y1.000 Z0.000 F180", "G1 X21.000 Y1.000 Z-0.1000"].join("\n")));
  assert.doesNotThrow(() => check([...contract, "G0 X1.000 Y1.000", "; RAMP ENTRY approach Z0.5000 target Z-0.1000 over 20.000 mm", "G1 Z0.5000 F40", "G1 X6.000 Y1.000 Z-0.1000 F180", "G1 X11.000 Y1.000 Z0.1000", "G1 X21.000 Y1.000 Z-0.1000"].join("\n")));
  assert.throws(() => check([...contract, "G0 X1.000 Y1.000", "; RAMP ENTRY approach Z0.5000 target Z-0.1000 over 20.000 mm", "G1 Z0.5000 F40", "G1 X21.000 Y1.000 Z-0.1000", "G1 X22.000 Y1.000 Z0.000"].join("\n")), /unguarded cutting move touches/);
  assert.throws(() => check([...contract, "G0 X1.000 Y1.000", "; RAMP ENTRY approach Z0.5000 target Z-0.0250 over 5.000 mm", "G1 Z0.5000 F80", "G1 X8.000 Z-0.0250"].join("\n")), /ramp at least 20 mm/);
  assert.throws(() => check([...contract, "G0 X1.000 Y1.000", "; RAMP ENTRY approach Z0.5000 target Z-0.1000 over 20.000 mm", "G1 Z0.5000 F40", "G1 X21.000 Y1.000 Z-0.1000", "G0 X2.000 Y1.000"].join("\n")), /XY rapid below safe Z/);
});

test("RU2100 sacrificial profile uses one continuous 0.025 mm-per-lap spiral, six tabs, and the exact approved depth", () => {
  const clampSource = extractNamedFunction(html, "cncClamp");
  const appendSource = extractNamedFunction(html, "cncAppendCutout");
  const checkSource = extractNamedFunction(html, "cncAssertRu2100ProfileSafety");
  const append = new Function(`${clampSource};${appendSource}; return cncAppendCutout;`)();
  const check = new Function(`${checkSource}; return cncAssertRu2100ProfileSafety;`)();
  const g = [];
  append(g, 114, 88, { matThick: 4.014, cutout: "tabs", tabs: 6, tabHeight: 1.5, bitR: 3.175, feed: 400, plunge: 80, safeZ: 3.2, passDepth: 0.025, rampLengthMm: 20, points: [[2,2],[112,2],[112,86],[2,86],[2,2]], noOvercut: true });
  const text = g.join("\n"), targets = [...text.matchAll(/^; PROFILE SPIRAL LOOP start Z-?[\d.]+ target Z(-?[\d.]+)/gm)].map((m) => Number(m[1]));
  assert.match(text, /with 6 tabs 1\.5mm through 4\.014mm stock/);
  assert.match(text, /PROFILE ENTRY POLICY: one continuous contour spiral/);
  assert.match(text, /PROFILE SPIRAL POLICY: descend no more than 0\.0250 mm per complete contour lap/);
  assert.equal(targets.length, Math.ceil(4.014 / 0.025));
  assert.equal(Math.min(...targets), -4.014);
  for (let i = 1; i < targets.length; i++) assert.ok(Math.abs(targets[i] - targets[i - 1]) <= 0.0251);
  assert.doesNotThrow(() => check(text));
  assert.equal(g[0].startsWith("; --- Profile cut-out"), true);
  assert.equal(g.at(-1), "G0 Z3.20");
  assert.match(text, /G0 X2\.000 Y2\.000\nG1 Z0\.5000 F80/);
  assert.doesNotMatch(text, /^G1 Z-/m);
  assert.equal((text.match(/^G0 Z/mg) || []).length, 1);
});

test("RU2100 rough safety gate requires the exact chip-load contract and cleared-Z ramps", () => {
  const source = extractNamedFunction(html, "cncAssertRu2100RoughSafety");
  const check = new Function(`${source}; return cncAssertRu2100RoughSafety;`)();
  const good = [
    "; 114.0x88.0 mm, depth 1 mm, 143x110 grid, ~0.80 mm stepover, stage rough, 34 rough passes @ 0.0250 mm",
    "; ENTRY POLICY: RU2100 moves XY first at existing safe Z, then ramps 20.0 mm from above stock; no vertical move at or below Z0",
    "; RU2100 CONSERVATIVE CONTRACT: 18000 RPM | 2 cutting edges | 400 mm/min | chip load 0.01111 mm/tooth",
    "; RADIAL ENGAGEMENT: 0.800 mm actual / 6.350 mm = 12.6% | AXIAL STEP 0.0250 mm",
    "; START POLICY: current work Z must be at least 2.400 mm; first axis motion is XY and never Z down",
    "; ENTRY LENGTH POLICY: require a tool-clear interior lane at least 8.0 mm long; shuttle only inside that lane until 20.0 mm of gradual XY ramp is complete",
    "G21",
    "G90",
    "G17",
    "G4 P2",
    "G0 X1.000 Y1.000",
    "; RAMP ENTRY approach Z0.5000 target Z-0.0250 over 20.000 mm",
    "G1 Z0.5000 F80",
    "G1 X20.000 Z-0.0250 F300",
    "G0 Z2.400",
    "G0 X20.000 Y2.000",
    "; RAMP ENTRY approach Z0.5000 target Z-0.0500 over 20.000 mm",
    "G1 Z0.5000 F80",
    "G1 X0.000 Z-0.0500 F300",
  ].join("\n");
  assert.doesNotThrow(() => check(good));
  assert.throws(() => check(good.replace("0.0250 mm", "0.0800 mm")), /axial step/);
  assert.throws(() => check(good.replace("G0 X1.000 Y1.000", "G0 Z2.400\nG0 X1.000 Y1.000")), /first axis motion must be XY/);
  assert.throws(() => check(good.replace("G1 Z0.5000 F80", "G1 Z-0.0200 F80")), /vertical move reaches the metal surface/);
  assert.throws(() => check(good.replace("over 20.000 mm", "over 6.378 mm")), /invalid ramp geometry/);
  const omitted = good.split("\n").slice(0, 6).concat("; RU2100 ROUGH OMITTED: no tool-clear interior lane >= 8.000 mm").join("\n");
  assert.deepEqual(check(omitted).omitted, true);
});

test("RU2100 fresh start requires a retracted work Z", () => {
  const source = extractNamedFunction(html, "cncStartFrameCheck");
  const check = new Function(`${source}; return cncStartFrameCheck;`)();
  const health = {workspace:{calibrated:true,bounds:{X:{min:-200,max:200},Y:{min:-200,max:200},Z:{min:-100}}},setup:{zOriginMPos:-10},lastControllerStatus:{MPos:"0,0,-7.6"}};
  assert.equal(check(health).ok, true);
  health.lastControllerStatus.MPos="0,0,-7.7";
  assert.equal(check(health).ok, false);
  assert.match(check(health).reason, /at least 2\.400 mm/);
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
  assert.match(api, /Approve the machining plan before Start/);
  assert.match(api, /parkside:cnc:plan:/);
  assert.match(api, /gcodeStages/);
  assert.match(api, /gcodeStagesGzip/);
  assert.match(api, /job\.stageRequiresProbe=true;job\.stageActivatedAt=now;job\.resumeInvalidatedAt=now/);
  assert.match(api, /interrupted checkpoint belongs to an older generated program/);
  assert.match(html, /resumeInvalidatedAt>=resumeUpdatedAt/);
  assert.match(api, /\["rough","finish","detail","all","profile"\]/);
  assert.match(api, /@gzip:/);
  assert.match(api, /command\.gcodeGzip/);
  assert.match(api, /cmd\.manualRouter=job\.planStatus==="approved"/);
  assert.match(api, /allowSacrificialCutThrough/);
  assert.match(api, /sacrificialBackingConfirmed/);
  assert.match(api, /requestedStage/);
  assert.match(api, /Explicit confirmation is required to replace the locked Z calibration/);
  assert.match(api, /cmd\.confirmReprobe=b\.confirmReprobe===true/);
  assert.match(api, /cmd\.confirmNewProject=true/);
  assert.match(api, /restore_probe/);
  assert.match(api, /Explicit X\/Y-only probe restoration confirmation is required/);
  assert.doesNotMatch(api, /Test the probe circuit with the plate touching the bit before probing the bed/);
  assert.match(api, /health\.xyRecovery/);
  assert.match(api, /This stage changed bits\. Use Changed bit/);
  assert.match(api, /probeLockStatus==="locked_after_tool_touch"/);
  assert.match(api, /probeLockedAt>completedAt&&probeLockedAt<=stageActivatedAt/);
  assert.match(api, /stageActivatedAt-probeLockedAt\)<=30\*60\*1000/);
  assert.match(api, /Jog step is outside the safe per-click limit/);
  assert.match(api, /const maxStep=axis==="Z"\?5:100/);
  assert.match(api, /Project allows .+ around this stock/);
  assert.match(api, /cmd\.stockWidthMm=Number\(st\.config\.machX\)/);
  assert.match(api, /Z jogs are limited to 5 mm per click/);
  assert.match(api, /job\.agentCommandId=cmd\.id/);
  assert.match(api, /do not press again/);
  assert.match(api, /const runControls=\["pause","resume","stop"\]/);
  assert.match(api, /Explicit saved-carve resume confirmation is required/);
  assert.match(api, /cmd\.allowReposition=true/);
  assert.match(api, /st\.config\.probeThickness=20/);
  assert.match(api, /cmd\.probeThickness=20/);
  assert.match(api, /Pause requires a running carve/);
  assert.match(api, /Resume requires a paused carve/);
  assert.match(api, /Stop requires an active carve/);
  assert.doesNotMatch(api, /fetch\(murl/);
});

test("local bridge retrieves its token from Keychain and uses the Unix socket", () => {
  assert.match(agent, /find-generic-password/);
  assert.match(agent, /openclaw-cnc-agent/);
  assert.match(agent, /socketPath: SOCKET_PATH/);
  assert.match(agent, /manualPositioning: true/);
  assert.match(agent, /splitJogDistance/);
  assert.match(agent, /stockWidthMm: command\.stockWidthMm/);
  assert.match(agent, /completedSegments/);
  assert.match(agent, /stockWidthMm/);
  assert.match(agent, /manualRouter: command\.manualRouter === true/);
  assert.match(agent, /profileDepthMm: command\.profileDepthMm/);
  assert.match(agent, /from "\.\/cnc-program-codec\.mjs"/);
  assert.match(agent, /from "\.\/cnc-command-policy\.mjs"/);
  assert.match(agent, /agentStartedAtMs/);
  assert.match(agent, /activeProgram: Boolean\(activeStart\)/);
  assert.match(codec, /gunzipSync/);
  assert.match(agent, /decodeProgram\(command\)/);
  assert.match(agent, /recover_probe: "\/probe\/recover"/);
  assert.doesNotMatch(agent, /test_probe|\/probe\/test/);
  assert.match(agent, /lock_probe: "\/probe\/lock"/);
  assert.match(agent, /unlock_probe: "\/probe\/unlock"/);
  assert.match(agent, /zero_z: "\/zero\/z"/);
  assert.match(agent, /recover_controller: "\/controller\/recover-stopped"/);
  assert.match(agent, /resume_saved: "\/job\/resume-saved"/);
  assert.match(agent, /allowReposition: command\.allowReposition === true/);
  assert.match(agent, /resume: health\?\.resume \|\| null/);
  assert.match(agent, /restore_xy: "\/zero\/xy\/restore-after-power-cycle"/);
  assert.match(agent, /confirmReprobe: command\.confirmReprobe === true/);
  assert.match(agent, /confirmNewProject: command\.confirmNewProject === true/);
  assert.match(agent, /restore_probe: "\/probe\/restore-after-xy-zero"/);
  assert.match(agent, /CNC_AGENT_PROBE_TIMEOUT_MS \|\| 180_000/);
  assert.match(agent, /"\/probe\/bed", "\/probe\/stock", "\/probe\/tool", "\/probe\/recover"/);
  assert.ok(agent.includes('const isHealth = path === "/health"'));
  assert.match(agent, /headers: isHealth \? \{\} :/);
  assert.match(agent, /if \(!isHealth\) req\.write\(data\)/);
  assert.doesNotMatch(agent, /console\.log\(token\)|process\.stdout\.write\(token/);
});

test("local daemon separates manual probe staging from the carve envelope", () => {
  assert.match(daemon, /negativeWorkspaceMarginMm/);
  assert.match(daemon, /new Set\(\["X", "Y"\]\)\.has\(axis\) \? 60 : 0/);
});

test("Project disables and rejects jogs outside the stock-aware envelope", () => {
  assert.match(html, /function cncJogFrameCheck/);
  assert.match(html, /Move blocked before reaching the machine/);
  assert.match(html, /data-axis="Y" data-dir="1"/);
  assert.match(daemon, /assertWorkJogWithinStock/);
  assert.match(daemon, /positioningBoundsFromStock/);
});

test("Project is completely independent of the external supervision camera", () => {
  assert.doesNotMatch(daemon, /camera/i);
  assert.doesNotMatch(agent, /camera/i);
  assert.doesNotMatch(controller, /camera/i);
  assert.doesNotMatch(html, /Camera status is informational|checking the camera/i);
});

test("recovery heartbeat maps progress back to the hosted Project job", () => {
  assert.match(agent, /replace\(\/-resume-\\d\+\$\/, ""\)/);
  assert.match(agent, /job: projectJob/);
});

test("CNC agent acknowledges controls quickly and accepted programs persist locally", () => {
  assert.match(agent, /IDLE_POLL_MS[^\n]+1500/);
  assert.match(agent, /IDLE_HEARTBEAT_MS[^\n]+60000/);
  assert.match(agent, /const projectHealth = \{/);
  assert.doesNotMatch(agent, /\.\.\.health/);
  assert.match(agent, /post-command heartbeat/);
  assert.match(api, /agentKey,JSON\.stringify\(rec\),\{ex:180\}/);
  assert.match(daemon, /saveProgram\(PROGRAM_STATE_PATH/);
  assert.match(daemon, /\/job\/last/);
  assert.match(html, /state==='queued'\|\|state==='accepted'/);
  assert.match(html, /immediate\?150:delay/);
  assert.doesNotMatch(html, /setInterval\(function\(\)\{ var m=document\.getElementById\('cncMain'\)/);
});

test("high-resolution G-code gets a program-only transport allowance", () => {
  assert.match(daemon, /const MAX_BODY_BYTES = 900_000/);
  assert.match(daemon, /const MAX_PROGRAM_BODY_BYTES = 10_000_000/);
  assert.match(daemon, /bodyJson = async \(req, maxBytes = MAX_BODY_BYTES\)/);
  assert.match(daemon, /req\.url === "\/job\/import"[\s\S]*bodyJson\(req, MAX_PROGRAM_BODY_BYTES\)/);
  assert.match(daemon, /req\.url === "\/job\/start"[\s\S]*bodyJson\(req, MAX_PROGRAM_BODY_BYTES\)/);
  assert.match(daemon, /req\.url === "\/query"[\s\S]*bodyJson\(req\)/);
  assert.match(program, /maxBytes = 10_000_000/);
  assert.match(program, /maxLines = 750_000/);
  assert.match(html, /budget:\(stage==='finish'\?700000:/);
});

test("local Project recovery UI can restore stopped controller state without cloud storage", () => {
  assert.match(daemon, /Project CNC · Local recovery/);
  assert.match(daemon, /\/controller\/recover-stopped/);
  assert.match(daemon, /\/job\/start-saved/);
  assert.match(daemon, /\/job\/import/);
  assert.match(daemon, /restoreOrRebaseLockedXy\(result\.after, workOffset\)/);
  assert.match(daemon, /auto_restored_after_power_cycle/);
  assert.match(daemon, /Explicit new-project X\/Y reset confirmation is required/);
  assert.match(html, /Restore probes after X\/Y-only reset/);
  assert.match(html, /function cncRestoreProbeAfterXy/);
  assert.match(daemon, /probePreserved: setup\.probeLocked === true/);
  assert.match(daemon, /new Set\(\["locked", "restored"\]\)\.has\(setup\.xyLockStatus\)/);
  assert.match(daemon, /\/probe\/restore-after-xy-zero/);
  assert.match(agent, /probeRecovery: health\?\.probeRecovery \|\| null/);
  assert.doesNotMatch(daemon, /Probe circuit is open|probeCircuitIsFresh|\/probe\/test/);
  assert.match(daemon, /removeProbeLock\(PROBE_STATE_PATH\);\s*removeMaterialProfile\(MATERIAL_STATE_PATH\);\s*clearProbeSetup\("reprobe_in_progress"\);/);
  assert.match(daemon, /restoreLockedProbe\(result\.after, workOffset\)/);
  assert.match(daemon, /Controller positioning is paused/);
  assert.match(daemon, /external router may be removed/);
  assert.match(daemon, /Enable positioning/);
  assert.match(daemon, /\/zero\/xy\/restore-after-power-cycle/);
  assert.match(daemon, /planXyPowerCycleRecovery/);
  assert.match(daemon, /reconnecting: Boolean\(reconnectPromise\)/);
  assert.doesNotMatch(daemon, /controller\.connected \? await xyRecoverySnapshot/);
});

test("Project exposes a visible guarded rear-Y limit recovery", () => {
  assert.match(html, /Release rear Y limit/);
  assert.match(html, /cncRecoverRearYLimit/);
  assert.match(html, /move only Y inward by exactly 5 mm/);
  assert.match(api, /recover_rear_y_limit/);
  assert.match(agent, /recover_rear_y_limit: "\/controller\/recover-rear-y-limit"/);
  assert.match(daemon, /\/controller\/recover-rear-y-limit/);
  assert.match(daemon, /controller\.recoverRearYLimit/);
});

test("daemon persists per-line recovery checkpoints and validates position before resume", () => {
  assert.match(daemon, /controller\.on\("programProgress"[\s\S]*persistRunProgress/);
  assert.match(daemon, /\/job\/resume-saved/);
  assert.match(daemon, /Resume position mismatch on/);
  assert.match(daemon, /buildResumeProgram/);
  assert.match(daemon, /buildCheckpointReplayResume/);
  assert.match(daemon, /payload\.allowReposition === true/);
  assert.match(daemon, /captureInterruptedPosition/);
  assert.match(html, /allowReposition:true/);
  assert.match(daemon, /payload\.dryRun === true/);
  assert.match(controller, /if \(this\.abortRequested\) throw new Error\("PROGRAM_ABORTED"\);\s*if \(guardError\)/);
  assert.match(controller, /this\.pauseRequested = false;\s*await this\.#emergencyStop\(reason\)/);
  assert.match(controller, /Held program buffer was not cleared; refusing to resume axis motion/);
  assert.match(daemon, /persistRunProgress\(\{ state: "interrupted", message: "Stopped by Project" \}\)/);
  assert.match(daemon, /DISCARD_BUFFERED_PROGRAM_AFTER_PROJECT_STOP/);
  assert.match(daemon, /PROBE_PUCK_THICKNESS_MM = 20/);
  assert.match(daemon, /saved probe puck is/);
});

test("bed re-probe atomically replaces Z and material measurements but preserves X/Y", () => {
  assert.match(daemon, /setup\.probeLocked && payload\.confirmReprobe !== true/);
  assert.match(daemon, /removeProbeLock\(PROBE_STATE_PATH\);\s*removeMaterialProfile\(MATERIAL_STATE_PATH\);\s*clearProbeSetup\("reprobe_in_progress"\);/);
  assert.doesNotMatch(daemon, /removeXyLock\(XY_STATE_PATH\);\s*clearProbeSetup\("reprobe_in_progress"\)/);
});
