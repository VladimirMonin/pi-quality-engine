import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {quote,nano,decimal,CampaignLedger,payloadAdmission,guardedFetch} from '../scripts/k09-budget.mjs';
const route={purpose:'subject',currency:'USD',model:'deepseek-v4.1-flash',endpoint:'https://ollama.com/v1/chat/completions',inputCeiling:1048576,outputCeiling:393216,inputRate:'0.30',outputRate:'1.20',maxTokens:4096};
const request=(changes={})=>({method:'POST',body:JSON.stringify({model:route.model,max_tokens:4096,reasoning_effort:'high',stream:true,messages:[{role:'user',content:'actual synthetic source canary'}],...changes})});
async function fixture(fn){const root=await mkdtemp(join(tmpdir(),'qe-354-'));try{await fn(root);}finally{await rm(root,{recursive:true,force:true});}}
const terminal=(usage={prompt_tokens:100,completion_tokens:100,total_tokens:200},ending=true)=>new Response('data: '+JSON.stringify({id:'req-fixture',model:route.model,usage:null})+'\r\n\r\n'+'data: '+JSON.stringify({usage})+'\r\n\r\n'+(ending?'data: [DONE]\r\n\r\n':''));
test('complete input and reasoning-capable output reserve are not a free request',()=>{assert.equal(quote(route),786432000n);assert.equal(decimal(quote(route)*3n),'2.359296000');});
test('unknown input, price and nonintegral/negative values deny before admission',()=>{for(const change of [{inputCeiling:null},{outputCeiling:0},{inputRate:'unknown'},{inputCeiling:1.5},{outputRate:'-1'}])assert.throws(()=>quote({...route,...change}));});
test('currency precision and negative remaining are not floating-point or FX',()=>{assert.equal(nano('0.000000001'),1n);assert.equal(decimal(-1n),'-0.000000001');assert.throws(()=>nano('1e-3'));});
test('actual full provider serialization must preserve HIGH, cap, route, bodies and no tools',()=>{
 const p=payloadAdmission(route,route.endpoint,request());assert.ok(p.body.messages[0].content.includes('actual synthetic source canary'));
 for(const change of [{reasoning_effort:'low'},{max_tokens:8192},{model:'another-model'},{tools:[{type:'function'}]},{max_completion_tokens:4096}])assert.throws(()=>payloadAdmission(route,route.endpoint,request(change)));
 assert.throws(()=>payloadAdmission(route,route.endpoint,request({messages:[{role:'user',content:'K09_PRIVATE_354_SENTINEL'}]})));
 assert.throws(()=>payloadAdmission(route,route.endpoint,request({messages:[{role:'user',content:'test-secret'}]}),['test-secret']));
 assert.throws(()=>payloadAdmission(route,route.endpoint,request({messages:[{role:'user',content:'x'.repeat(40000)}]})));
});
test('persistent intent survives resume as UNKNOWN and cannot refund or duplicate',()=>fixture(async root=>{
 const p=join(root,'ledger.json');let l=new CampaignLedger(p,'tuple');l.reserve(route,'case-002',{sha256:'x'});l.close();l=new CampaignLedger(p,'tuple');try{assert.equal(l.state.attempts[0].status,'unknown');assert.equal(l.totals('USD').unknownExposure,'0.786432000');assert.throws(()=>l.reserve(route,'case-003',{}));}finally{l.close();}
}));
test('USD and RUB reservations remain separate; no per-session renewal or duplicate charge',()=>fixture(async root=>{
 const p=join(root,'ledger.json'),l=new CampaignLedger(p,'tuple');try{
  const id=l.reserve(route,'case-002',{});l.dispatched(id);l.settle(id,route,{prompt_tokens:100,completion_tokens:100,total_tokens:200});const before=l.totals('USD');assert.equal(before.accountedUpper,'0.000150000');assert.equal(before.actualReported,null);assert.equal(l.totals('RUB').actualReported,'0.000000000');assert.throws(()=>l.reserve(route,'case-002',{}));
  l.settle(id,route,{prompt_tokens:100,completion_tokens:100,total_tokens:200});assert.deepEqual(l.totals('USD'),before);
 }finally{l.close();}
}));
test('a complete-looking RUB token receipt without actual cost stays unknown',()=>fixture(async root=>{
 const r={...route,purpose:'evaluator',currency:'RUB'},l=new CampaignLedger(join(root,'l'),'t');try{const id=l.reserve(r,'case-002',{});l.dispatched(id);l.settle(id,r,{prompt_tokens:100,completion_tokens:100,total_tokens:200});assert.equal(l.row(id).status,'unknown');assert.equal(l.totals('RUB').actualReported,'0.000000000');assert.notEqual(l.totals('RUB').unknownExposure,'0.000000000');}finally{l.close();}
}));
test('a reduced money ceiling refuses before physical delegate',()=>fixture(async root=>{
 const l=new CampaignLedger(join(root,'l'),'t',{USD:'0.01',RUB:'20'});let calls=0;const g=guardedFetch({routes:[route],ledger:l,delegate:async()=>{calls++;return terminal();},caseId:()=> 'case-002'});try{await assert.rejects(g.fetch(route.endpoint,request()));assert.equal(calls,0);await g.drain();}finally{l.close();}
}));
test('ordinary SSE null interim usage, CRLF and final raw counters settle once',()=>fixture(async root=>{
 const l=new CampaignLedger(join(root,'l'),'t');let calls=0;const g=guardedFetch({routes:[route],ledger:l,delegate:async()=>{calls++;return terminal();},caseId:()=> 'case-002'});try{const r=await g.fetch(route.endpoint,request());await r.text();await g.drain();assert.equal(calls,1);assert.equal(l.state.attempts[0].status,'settled');assert.equal(l.state.closed,null);}finally{l.close();}
}));
test('missing/partial usage and HTTP refusal close admission, retain exposure, never retry',()=>fixture(async root=>{
 for(const [name,reply]of [['missing',()=>terminal(null)],['partial',()=>terminal({prompt_tokens:100})],['http',()=>new Response('harmless refusal',{status:503})]]){
  const l=new CampaignLedger(join(root,name),'t');let calls=0;const g=guardedFetch({routes:[route],ledger:l,delegate:async()=>{calls++;return reply();},caseId:()=> 'case-002'});
  try{await g.fetch(route.endpoint,request());await g.drain();assert.equal(l.state.attempts[0].status,'unknown');await assert.rejects(g.fetch(route.endpoint,request()));assert.equal(calls,1);}finally{l.close();}
 }
}));
test('ignored abort retains physical promise and reservation until actual release',()=>fixture(async root=>{
 const l=new CampaignLedger(join(root,'l'),'t');let release;const held=new Promise(r=>release=r);const g=guardedFetch({routes:[route],ledger:l,delegate:async()=>held,caseId:()=> 'case-002',requestMs:30});
 try{const pending=g.fetch(route.endpoint,request());await new Promise(r=>setTimeout(r,60));assert.equal(l.state.attempts[0].status,'unknown');assert.equal(l.totals('USD').unknownExposure,'0.786432000');release(terminal(null));await pending;await g.drain();await assert.rejects(g.fetch(route.endpoint,request()));}finally{l.close();}
}));
test('independent native watchdog observes exact child exit/close, not signal delivery alone',async()=>{
 const p=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{env:{SystemRoot:process.env.SystemRoot,PATH:process.env.PATH},stdio:['ignore','pipe','pipe']});let code,signal,closed=false;p.on('exit',(c,s)=>{code=c;signal=s;});const done=new Promise(r=>p.on('close',()=>{closed=true;r();}));await new Promise(r=>setTimeout(r,80));p.kill();await done;assert.equal(closed,true);assert.ok(code!==undefined||signal);
});
