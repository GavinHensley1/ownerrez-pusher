import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { gunzipSync } from 'node:zlib';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import cam from '../api/cnc-certified-library.cjs';
import proofCam from '../api/cnc-wood-proof.cjs';
import { analyzeProgram, validateProgramStockEnvelope, limitVerticalPlungeFeed } from './cnc-program.mjs';
import { saveProgram, readProgram } from './cnc-program-state.mjs';
import { GrblTcpController } from './cnc-controller.mjs';
import { inspectEffectiveCutFrame } from './cnc-effective-frame.mjs';
import { loadBrowserScript } from './cnc-browser-harness.mjs';

const library = cam.loadCertifiedLibrary(proofCam.LIBRARY_ID);
const stock = { stockWidthMm:279.4, stockHeightMm:101.6, stockReserveMm:5 };
const proof = { ...proofCam.placement({ ...stock, leftInsetMm:5, frontInsetMm:5 }), configuredAt:'2026-10-11T18:00:00.000Z' };
function context(stage='rough') {
  const cert=library.programs[stage].certificate;
  return { ...stock, woodProof:proof, certifiedLibraryId:proofCam.LIBRARY_ID, material:'Wood', operation:stage, camStage:stage, manualRouter:true,
    camProvider:cert.provider, camCertification:cert.certification, camSourceHash:cert.sourceHash, camAuditHash:cert.auditHash, camTool:cert.tool };
}
const code = stage => gunzipSync(Buffer.from(library.programs[stage].gzipBase64,'base64')).toString('utf8');
const stockOrigin = { X:-120, Y:-140, Z:-30 };

test('the exact Rough and Finish sources fit only after a cutter-aware translation',()=>{
  assert.equal(proof.offsetXMm,-4.425);assert.equal(proof.offsetYMm,-14.905);
  assert.deepEqual(proof.bounds,{minX:5,maxX:116.15,minY:5,maxY:95.19});
  for(const stage of proofCam.STAGES){
    const original=code(stage),analysis=analyzeProgram(original,{spindleMode:'manual'});
    assert.equal(limitVerticalPlungeFeed(original,60),original);
    proofCam.verifyProgram(original,context(stage));
    assert.throws(()=>validateProgramStockEnvelope(analysis,{widthMm:279.4,heightMm:101.6,reserveMm:5}),/maximum/);
    const translated=proofCam.translatedAnalysis(analysis,proof,stage,true);
    assert.equal(validateProgramStockEnvelope(translated,{widthMm:279.4,heightMm:101.6,reserveMm:5}),true);
    assert.equal(translated.bounds.Z.min,analysis.bounds.Z.min);
    assert.throws(()=>proofCam.verifyProgram(original+'\n',context(stage)),/exact certified source/);
  }
  assert.throws(()=>proofCam.placement({...stock,leftInsetMm:5,frontInsetMm:10}),/does not fit/);
  assert.throws(()=>proofCam.validatePlacement(proof,{...stock,stockHeightMm:100}),/dimensions changed/);
  assert.throws(()=>proofCam.validatePlacement({...proof,offsetYMm:0},stock),/inconsistent/);
  assert.throws(()=>proofCam.assertStage('profile'),/Rough and Finish only/);
});

test('clone preserves setup metadata and original job, strips metal cutout, uses source RPMs',()=>{
  const source={id:'metal',project:'Rambo',certifiedLibraryId:proofCam.LIBRARY_ID,planStatus:'approved',activeStage:'rough',stageRequiresProbe:true,
    stageActivatedAt:'2026-10-11T17:00:00Z',material:'C752 nickel silver',metalMode:'raised-surface',xyLockedAt:'xy-kept',probeLockedAt:'z-kept',
    camCertificates:JSON.stringify(Object.fromEntries(proofCam.STAGES.map(s=>[s,library.programs[s].certificate]))),
    gcodeNames:JSON.stringify({rough:'rough.nc',finish:'finish.nc'}),agentState:'done'};
  const before=structuredClone(source),job=proofCam.makeJob(source,'wood',proof,proof.configuredAt);
  assert.deepEqual(source,before);assert.equal(job.material,'Wood');assert.equal(job.metalMode,'');assert.equal(job.xyLockedAt,'xy-kept');assert.equal(job.probeLockedAt,'z-kept');
  assert.equal(job.agentState,undefined);assert.equal(job.profileMode,'none');assert.equal(job.stageActivatedAt,source.stageActivatedAt);
  assert.deepEqual(JSON.parse(job.gcodeStages),['rough','finish']);
  assert.equal(JSON.parse(job.planTools).roughRpm,10600);assert.equal(JSON.parse(job.planTools).finishRpm,14950);
});

test('saved context retains and revalidates the placement and exact source across restart',()=>{
  const path=join(mkdtempSync(join(tmpdir(),'cnc-wood-proof-')),'program.json');
  const original=code('rough'),saved=saveProgram(path,{version:1,jobId:'wood',gcode:original,context:context()});
  assert.deepEqual(readProgram(path).context.woodProof,proof);assert.equal(readProgram(path).gcode,original);
  assert.equal(saved.context.camSourceHash,context().camSourceHash);
  assert.throws(()=>saveProgram(path,{version:1,jobId:'wood',gcode:original,context:{...context(),woodProof:{...proof,offsetYMm:0}}}),/inconsistent/);
});

test('G55 frame validation requires unchanged stock XYZ and zero hidden offsets',()=>{
  const expected={X:stockOrigin.X+proof.offsetXMm,Y:stockOrigin.Y+proof.offsetYMm,Z:stockOrigin.Z};
  const input={modalLines:['[GC:G0 G55 G17 G21 G90 G94 M5]'],parameterLines:[`[G54:${Object.values(stockOrigin).join(',')}]`,`[G55:${Object.values(expected).join(',')}]`,'[G92:0,0,0]','[TLO:0]'],status:{state:'Idle',MPos:'-100,-100,-25',WCO:Object.values(expected).join(',')},activeWcs:'G55',expectedOrigin:expected,expectedStockOrigin:stockOrigin};
  assert.equal(inspectEffectiveCutFrame(input).activeWcs,'G55');
  assert.throws(()=>inspectEffectiveCutFrame({...input,expectedStockOrigin:{...stockOrigin,Z:-31}}),/G54 Z changed/);
  assert.throws(()=>inspectEffectiveCutFrame({...input,expectedOrigin:{...expected,Z:-31}}),/G55 Z differs/);
  assert.throws(()=>inspectEffectiveCutFrame({...input,parameterLines:input.parameterLines.map(x=>x==='[G92:0,0,0]'?'[G92:0,0,.001]':x)}),/G92 Z/);
});

// Simulated controller only: ephemeral loopback port, no machine address/state.
async function makeGrbl({ failFrame=false, failCut=false, initialWcs='G54' }={}) {
  let wcs=initialWcs,units='G20',held=false,failed=false;
  const offsets={G54:{...stockOrigin},G55:{X:0,Y:0,Z:0}},position={X:-120,Y:-140,Z:-25};
  const commands=[],motion=[];const sockets=new Set();
  const server=net.createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));let buffer='';socket.on('data',bytes=>{
    for(const byte of bytes){const ch=String.fromCharCode(byte);
      if(ch==='?'){socket.write(`<${held?'Hold:0':'Idle'}|MPos:${Object.values(position).map(x=>x.toFixed(4)).join(',')}|WCO:${Object.values(offsets[wcs]).map(x=>x.toFixed(4)).join(',')}|FS:0,0>\r\n`);continue;}
      if(ch==='!'){held=true;continue;}if(byte===0x85||byte===0x9e)continue;
      if(byte===0x18){held=false;buffer='';socket.write('Grbl 1.1h [reset]\r\n');continue;}
      if(ch==='~'){commands.push('~');held=false;continue;}
      buffer+=ch;if(ch!=='\r')continue;const command=buffer.trim();buffer='';commands.push(command);
      if(command==='$$'){socket.write('$13=0\r\n$20=0\r\n$21=1\r\n$100=800\r\n$101=800\r\n$102=800\r\n$130=400\r\n$131=400\r\n$132=80\r\nok\r\n');continue;}
      if(command==='$G'){socket.write(`[GC:G0 ${wcs} G17 ${units} G90 G94 M5 M9]\r\nok\r\n`);continue;}
      if(command==='$#'){socket.write(`[G54:${Object.values(offsets.G54).join(',')}]\r\n[G55:${Object.values(offsets.G55).join(',')}]\r\n[G92:0,0,0]\r\n[TLO:0]\r\nok\r\n`);continue;}
      if(command==='G21')units='G21';
      else if(/^G10 L2 P2 /.test(command)){
        assert.equal(units,'G21');for(const m of command.matchAll(/([XYZ])([-+0-9.]+)/g))offsets.G55[m[1]]=Number(m[2]);
        if(failFrame)offsets.G55.Z-=1;
      }else if(command==='G55'||command==='G54')wcs=command;
      else if(/^G[01]\b/.test(command)&&/[XYZ][-+0-9.]/.test(command)){
        if(failCut&&!failed&&/^G1\b/.test(command)){failed=true;socket.write('error:20\r\n');continue;}
        if(held){socket.write('error:9\r\n');continue;}
        for(const m of command.matchAll(/([XYZ])([-+0-9.]+)/g))position[m[1]]=offsets[wcs][m[1]]+Number(m[2]);
        motion.push({command,wcs,position:{...position}});
      }
      socket.write('ok\r\n');
    }
  });});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {port:server.address().port,commands,motion,offsets,position,get wcs(){return wcs;},
    close:async()=>{for(const s of sockets)s.destroy();await new Promise(resolve=>server.close(resolve));}};
}
const controllerFor = mock=>new GrblTcpController({host:'127.0.0.1',port:mock.port,statusTimeoutMs:100,commandTimeoutMs:500,motionGuard:async()=>{},programGuard:async()=>{},maxProgramSocketLines:0});

test('serialized G55 placement streams original moves and verifies restored G54 before return',async()=>{
  const mock=await makeGrbl(),controller=controllerFor(mock);
  try{
    const result=await controller.runProgram(code('rough'),{programContext:context(),expectedOrigin:stockOrigin});
    assert.equal(result.after.state,'Idle');assert.equal(mock.wcs,'G54');assert.deepEqual(mock.offsets.G54,stockOrigin);
    assert(mock.commands.indexOf('G21')<mock.commands.findIndex(x=>x.startsWith('G10 L2 P2')));
    const expectedMoves=analyzeProgram(code('rough'),{spindleMode:'manual'}).lines.filter(x=>/^G[01]\b/.test(x)&&/[XYZ][-+0-9.]/.test(x));
    assert.deepEqual(mock.motion.map(x=>x.command),expectedMoves);assert(mock.motion.every(x=>x.wcs==='G55'));
    assert(mock.motion.filter(x=>/[XY][-+0-9.]/.test(x.command)).every(x=>x.position.X>=stockOrigin.X+5&&x.position.Y>=stockOrigin.Y+5));
    assert(mock.motion.every(x=>x.position.Y<=stockOrigin.Y+101.6-5));
    assert(!mock.commands.includes('~'));assert(!mock.commands.some(x=>/^G10 L\d+ P1/.test(x)));
  }finally{await controller.close();await mock.close();}
});

for(const [label, options, error] of [
  ['placement readback failure',{failFrame:true},/G55 Z differs/],
  ['stream failure',{failCut:true},/error:20/],
])test(label+' keeps setup blocked until buffer discard and stock-frame restoration',async()=>{
  const mock=await makeGrbl(options),controller=controllerFor(mock);
  try{
    await assert.rejects(controller.runProgram(code('rough'),{programContext:context(),expectedOrigin:stockOrigin}),error);
    if(options.failFrame)assert.equal(mock.motion.length,0);
    assert.equal(mock.wcs,'G55');assert.deepEqual(mock.offsets.G54,stockOrigin);
    await controller.resetConnection();
    await assert.rejects(controller.restoreStockFrame({allowG55:true}),/stationary Idle/);
    const stopped={...mock.position};
    await controller.discardHeldMotion();
    await controller.restoreStockFrame({expectedOrigin:stockOrigin,allowG55:true});
    assert.equal(mock.wcs,'G54');assert.deepEqual(mock.position,stopped);assert(!mock.commands.includes('~'));
  }finally{await controller.close();await mock.close();}
});

test('fresh-process recovery selects known G55 back to G54 without changing zeros or moving',async()=>{
  const mock=await makeGrbl({initialWcs:'G55'}),controller=controllerFor(mock);
  try{
    await assert.rejects(controller.restoreStockFrame(),/Unexpected coordinate frame/);
    await controller.restoreStockFrame({allowG55:true,expectedOrigin:stockOrigin});
    assert.equal(mock.wcs,'G54');assert.deepEqual(mock.offsets.G54,stockOrigin);assert.equal(mock.motion.length,0);
  }finally{await controller.close();await mock.close();}
});

test('operator UI offers only isolated stationary probe-contact recovery, never general Alarm movement',()=>{
  const ui=loadBrowserScript(new URL('../index.html',import.meta.url));
  const job={id:'wood',material:'Wood',hasGcode:false};
  for(const [state,pins,fs,allowed] of [['Alarm','PZ','0,0',true],['Alarm','P','0,0',true],['Idle','P','0,0',true],['Alarm','PXY','0,0',false],['Run','PZ','0,0',false],['Hold:0','PZ','0,0',false],['Alarm','PZ','1,0',false],['Alarm','PZ','0,1',false]]){
    ui.renderAgent(job,{connected:true,moving:false,frameValid:false,frameRecovery:{active:true},lastControllerStatus:{state,FS:fs,Pn:pins,MPos:'0,0,0'},setup:{},controllerProtection:{ready:false}},{});
    assert.equal(ui.elements.cncProbeRecoverBtn.disabled,!allowed,`${state} ${pins} ${fs}`);
    if(state==='Alarm'){assert(ui.jogButtons.every(b=>b.disabled));assert.equal(ui.elements.cncZeroBtn.disabled,true);assert.equal(ui.elements.cncProbeBedBtn.disabled,true);}
  }
});
