// Unshipped, campaign-owned accounting. Never imported by the shipped engine.
import fs from 'node:fs';
import {dirname} from 'node:path';
import {createHash} from 'node:crypto';
export class Refusal extends Error { constructor(code) { super(code); this.code=code; } }
export const digest=value=>createHash('sha256').update(value).digest('hex');
export function nano(value) {
  const s=typeof value==='number' && Number.isFinite(value) ? value.toFixed(9) : String(value);
  if(!/^(?:0|[1-9]\d*)(?:\.\d{1,9})?$/.test(s)) throw new Refusal('money-unknown-or-invalid');
  const [whole,part='']=s.split('.'); return BigInt(whole)*1000000000n+BigInt(part.padEnd(9,'0'));
}
export function decimal(value) { const valueN=BigInt(value),n=valueN<0n?-valueN:valueN; return `${valueN<0n?'-':''}${n/1000000000n}.${String(n%1000000000n).padStart(9,'0')}`; }
const integer=n=>Number.isSafeInteger(n)&&n>=0;
const ceil=(n,d)=>(n+d-1n)/d;
export function quote(route) {
  if(!integer(route.inputCeiling)||route.inputCeiling===0||!integer(route.outputCeiling)||route.outputCeiling===0) throw new Refusal('billable-token-ceiling-unqualified');
  return ceil(BigInt(route.inputCeiling)*nano(route.inputRate)+BigInt(route.outputCeiling)*nano(route.outputRate),1000000n);
}
export function atomic(path,value) {
  fs.mkdirSync(dirname(path),{recursive:true});const tmp=path+`.${process.pid}.tmp`,fd=fs.openSync(tmp,'wx');
  try {fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
  fs.renameSync(tmp,path);
}
export class CampaignLedger {
  constructor(path,tuple,limits={USD:'3',RUB:'20'}) {
    this.path=path;this.lock=path+'.lock';fs.mkdirSync(dirname(path),{recursive:true});
    this.fd=fs.openSync(this.lock,'wx');this.released=false;
    try {
      this.state=fs.existsSync(path)?JSON.parse(fs.readFileSync(path,'utf8')):{version:1,tuple,limits,closed:null,attempts:[],cases:{}};
      if(this.state.tuple!==tuple||JSON.stringify(this.state.limits)!==JSON.stringify(limits))throw new Refusal('campaign-identity-mismatch');
      for(const r of this.state.attempts)if(r.status==='intent'||r.status==='inflight'){r.status='unknown';r.reason='recovered-dispatch-may-have-occurred';this.state.closed=r.reason;}
      this.save();
    } catch(e) {this.close();throw e;}
  }
  save(){atomic(this.path,this.state);}
  totals(currency){
    let actual=0n,reserved=0n,unknown=0n;
    for(const r of this.state.attempts.filter(r=>r.currency===currency)){
      if(r.amount!==null)actual+=BigInt(r.amount);
      if(['intent','inflight'].includes(r.status))reserved+=BigInt(r.reserved);
      if(r.status==='unknown')unknown+=BigInt(r.reserved);
    }
    const cap=nano(this.state.limits[currency]);return {accountedUpper:decimal(actual),actualReported:currency==='RUB'?decimal(actual):null,reserved:decimal(reserved),unknownExposure:decimal(unknown),remainingAdmissible:decimal(cap-actual-reserved-unknown),basis:currency==='USD'?'conservative-tariff-credit-upper-not-an-invoice; discounts/cache/actual-debit-unknown':'provider-reported-RUB-when-known'};
  }
  reserve(route,caseId,request){
    if(this.state.closed)throw new Refusal('campaign-admission-closed');
    if(this.state.attempts.some(r=>r.status!=='settled'))throw new Refusal('unsettled-exposure');
    if(this.state.attempts.filter(r=>r.purpose===route.purpose).length>=3)throw new Refusal('route-request-ceiling');
    if(this.state.attempts.some(r=>r.caseId===caseId&&r.purpose===route.purpose))throw new Refusal('no-duplicate-case-dispatch');
    const reserved=quote(route),currency=route.currency;
    const spent=this.state.attempts.filter(r=>r.currency===currency).reduce((n,r)=>n+BigInt(r.amount??r.reserved),0n);
    if(spent+reserved>nano(this.state.limits[currency]))throw new Refusal('campaign-money-ceiling');
    const r={id:`request-${this.state.attempts.length+1}`,caseId,purpose:route.purpose,currency,model:route.model,reserved:String(reserved),amount:null,status:'intent',at:new Date().toISOString(),request};
    this.state.attempts.push(r);this.save();return r.id;
  }
  dispatched(id){const r=this.row(id);r.status='inflight';r.dispatchObservedAt=new Date().toISOString();this.save();}
  row(id){const r=this.state.attempts.find(r=>r.id===id);if(!r)throw new Refusal('unknown-attempt');return r;}
  unknown(id,reason){const r=this.row(id);if(r.status!=='settled'){r.status='unknown';r.reason=reason;}this.state.closed??=reason;this.save();}
  settle(id,route,usage,meta={}){
    const r=this.row(id);
    if(!usage||!integer(usage.prompt_tokens)||!integer(usage.completion_tokens)||!integer(usage.total_tokens)||usage.prompt_tokens+usage.completion_tokens!==usage.total_tokens){this.unknown(id,'terminal-usage-unknown');return;}
    let amount,basis;
    try {
      if(route.currency==='RUB'){
        if(usage.cost_rub===null||usage.cost_rub===undefined)throw new Refusal('reported-RUB-unknown');
        amount=nano(usage.cost_rub);basis='provider-cost_rub';
      }else{amount=ceil(BigInt(usage.prompt_tokens)*nano(route.inputRate)+BigInt(usage.completion_tokens)*nano(route.outputRate),1000000n);basis='conservative-full-input-output-tariff-credit-calculation';}
    }catch{this.unknown(id,'terminal-cost-unknown');return;}
    r.status='settled';r.amount=String(amount);r.actualReported=route.currency==='RUB'?decimal(amount):null;r.calculatedUpper=decimal(amount);r.basis=basis;r.usage={input:usage.prompt_tokens,output:usage.completion_tokens,total:usage.total_tokens,cached:usage.prompt_tokens_details?.cached_tokens??null,reasoningTokens:usage.completion_tokens_details?.reasoning_tokens??null};r.response=meta;r.settledAt=new Date().toISOString();
    if(amount>BigInt(r.reserved)||usage.prompt_tokens>route.inputCeiling||usage.completion_tokens>route.outputCeiling){this.state.closed='provider-ceiling-violation';r.ceilingViolation=true;}
    this.save();
  }
  caseResult(id,result){this.state.cases[id]=result;this.save();}
  close(){if(!this.released){this.released=true;if(this.fd!==undefined){fs.closeSync(this.fd);fs.unlinkSync(this.lock);}}}
}
export function payloadAdmission(route,url,init,secrets=[]) {
  if(String(url)!==route.endpoint||init?.method!=='POST'||typeof init.body!=='string')throw new Refusal('route-or-method-mismatch');
  const bytes=Buffer.byteLength(init.body);if(bytes>32768)throw new Refusal('full-request-byte-ceiling');
  if(secrets.some(s=>s&&init.body.includes(s))||/K09_ORACLE_ONLY_345_SENTINEL|K09_PRIVATE_354_SENTINEL/.test(init.body))throw new Refusal('private-input-refused');
  const b=JSON.parse(init.body);
  if(b.model!==route.model||b.max_tokens!==route.maxTokens||b.max_completion_tokens!==undefined||b.stream!==true||!Array.isArray(b.messages))throw new Refusal('serialization-contract-mismatch');
  if(route.purpose==='subject'&&b.reasoning_effort!=='high')throw new Refusal('subject-high-not-applied');
  if(route.purpose==='evaluator'&&(b.reasoning||b.reasoning_effort&&b.reasoning_effort!=='none'))throw new Refusal('evaluator-reasoning-not-approved');
  if(b.tools?.length)throw new Refusal('tools-outside-this-collection-increment');
  for(const m of b.messages)if(m.reasoning_content||m.reasoning_details)throw new Refusal('unapproved-reasoning-capture-boundary');
  return {bytes,sha256:digest(init.body),body:b};
}
const safeId=s=>typeof s==='string'&&/^[A-Za-z0-9._:/-]{1,160}$/.test(s)?s:null;
export function guardedFetch({routes,ledger,delegate,caseId,secrets=[],onInput=()=>{},requestMs=65000,deadline=Infinity}) {
  let active=Promise.resolve(),closed=false,refused=0;const pending=new Set();
  const fn=async(url,init)=>{
    const route=routes.find(r=>String(url)===r.endpoint);
    if(!route){refused++;closed=true;ledger.state.closed='non-study-network-refused';ledger.save();throw new Refusal('non-study-network-refused');}
    await active;if(closed)throw new Refusal('guard-closed');
    if(Date.now()>=deadline)throw new Refusal('case-admission-deadline');
    let checked;
    try{checked=payloadAdmission(route,url,init,secrets);}catch(e){refused++;closed=true;ledger.state.closed='request-admission-refused';ledger.save();throw e;}
    const id=ledger.reserve(route,caseId(),{bytes:checked.bytes,sha256:checked.sha256});
    let release;active=new Promise(r=>{release=r;});
    const controller=new AbortController();const signal=init.signal?AbortSignal.any([init.signal,controller.signal]):controller.signal;
    const timer=setTimeout(()=>{closed=true;ledger.unknown(id,'request-deadline-unknown');controller.abort();},Math.min(requestMs,route.requestTimeoutMs??requestMs,Math.max(1,deadline-Date.now())));
    const finish=()=>{clearTimeout(timer);release();};
    try {
      onInput(route,id,init.body);ledger.dispatched(id);
      const response=await delegate(url,{...init,signal,redirect:'error'});
      if(!response.ok||!response.body){closed=true;ledger.unknown(id,`http-${response.status}-unknown`);finish();return response;}
      const observe=(async()=>{
        const reader=response.clone().body.getReader(),decoder=new TextDecoder();let total=0,buffer='',done=false,usage=null,meta={};
        try {
          for(;;){
            const chunk=await reader.read();if(chunk.done)break;total+=chunk.value.length;if(total>1048576)throw new Refusal('response-byte-ceiling');buffer+=decoder.decode(chunk.value,{stream:true});buffer=buffer.replace(/\r\n/g,'\n');
            let end;while((end=buffer.indexOf('\n\n'))>=0){
              const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);if(frame.length>65536)throw new Refusal('stream-frame-ceiling');
              const data=frame.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');
              if(data==='[DONE]'){done=true;continue;}if(!data)continue;
              const x=JSON.parse(data);if(x.usage!==null&&x.usage!==undefined)usage=x.usage;
              meta={id:safeId(x.id)??meta.id??null,model:safeId(x.model)??meta.model??null}; // Never persist deltas/reasoning/header values.
            }
            if(buffer.length>65536)throw new Refusal('stream-frame-ceiling');
          }
          if(!done)throw new Refusal('stream-terminal-missing');
          ledger.settle(id,route,usage,{...meta,at:new Date().toISOString(),rawUsageSource:'native-provider-SSE-terminal'});
          if(meta.model&&!(route.actualModels??[route.model]).includes(meta.model)){ledger.state.closed='actual-route-mismatch';ledger.save();}
          if(ledger.state.closed)closed=true;
        }catch{closed=true;ledger.unknown(id,'response-or-usage-unknown');controller.abort();}
        finally{reader.releaseLock();finish();}
      })();pending.add(observe);observe.finally(()=>pending.delete(observe));return response;
    }catch(e){closed=true;ledger.unknown(id,e instanceof Refusal?e.code:'transport-outcome-unknown');finish();throw new Refusal('transport-or-admission-stopped');}
  };
  return {fetch:fn,drain:async()=>{await Promise.all([...pending]);await active;},pending:()=>pending.size,refused:()=>refused,close:()=>{closed=true;for(const r of ledger.state.attempts)if(['intent','inflight'].includes(r.status))ledger.unknown(r.id,'collector-retired-before-settlement');}};
}
