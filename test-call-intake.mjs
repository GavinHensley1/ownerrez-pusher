import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url);
const handler=require('./api/app.js');

assert.equal(handler.__calls.phoneDigits('+1 (865) 555-1212'),'8655551212');
assert.equal(handler.__calls.recordingSidOf('https://api.twilio.com/2010-04-01/Accounts/AC1/Recordings/RE123456789012345678901234'),'RE123456789012345678901234');
assert.deepEqual(handler.__calls.hookBody('From=%2B18655551212&RecordingSid=RE123'),{From:'+18655551212',RecordingSid:'RE123'});

let statusCode=0, contentType='', body='';
const req={query:{action:'voice',token:'test-token'},headers:{},body:{}};
const res={
  setHeader(k,v){if(String(k).toLowerCase()==='content-type') contentType=v;},
  status(n){statusCode=n;return this;},
  end(v){body=String(v||'');return this;},
  json(v){body=JSON.stringify(v);return this;}
};
await handler(req,res);
assert.equal(statusCode,200);
assert.equal(contentType,'text/xml');
assert.match(body,/recordingStatusCallback="[^\"]+action=voice_recording&amp;token=test-token"/);
assert.match(body,/recordingStatusCallbackMethod="POST"/);
assert.match(body,/recordingStatusCallbackEvent="completed"/);
assert.doesNotMatch(body,/transcribeCallback=/);
assert.doesNotMatch(body,/transcribe="true"/);

console.log('call-intake tests passed');
