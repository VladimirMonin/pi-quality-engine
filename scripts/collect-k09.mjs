// Deliberate, unshipped K09 calibration collector. No imports from this module dispatch.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {CampaignLedger,Refusal,quote,decimal,digest,atomic,guardedFetch} from './k09-budget.mjs';
const REPO=dirname(dirname(fileURLToPath(import.meta.url))),SELF=fileURLToPath(import.meta.url);
export const CASES=['case-002','case-003','case-001'];
const OLLAMA='C:/Users/User/.pi/agent/npm/node_modules/pi-ollama-cloud';
const POLZA='C:/Users/User/.pi/agent/git/github.com/VladimirMonin/pi-polza/.pi/extensions/pi-polza';
const FIXTURE=join(REPO,'test/fixtures/k09/v1');
const SOURCES=['adapters/pi-feedback','adapters/pi-host','adapters/pi-models','builtins/actions','builtins/contexts','builtins/evaluators','builtins/pi-reviewer','builtins/policies','builtins/prompts','builtins/triggers','checkpoint','configuration','context','contracts','diagnostics','evidence','feedback','git-evidence','index','journal','models','observation','registry','runtime','scheduling'];
const load=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const pin=p=>{const b=fs.readFileSync(p);return {bytes:b.length,sha256:digest(b)};};
const text=message=>{const s=(message?.content??[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');return /<\/?think\b|<\|(?:analysis|thinking)\|>/iu.test(s)?'':s;};
const stable=v=>JSON.stringify(v);
export function makePlan(root){
  const entry=load(join(root,'entry.json'));
  for(const [n,p]of Object.entries(entry.pins))if(stable(pin(join(REPO,n)))!==stable(p))throw new Refusal('accepted-or-baseline-bytes-changed');
  if(fs.readFileSync(join(REPO,'.git/refs/heads/main'),'utf8').trim()!==entry.head||stable(pin(join(REPO,'.git/index')))!==stable(entry.index))throw new Refusal('head-or-index-changed');
  const corpus=load(join(FIXTURE,'corpus.json')),labels=load(join(FIXTURE,'labels.json')),split=load(join(FIXTURE,'split.json'));
  const nativeFact=load(join(root,'native-polza-model.json'));
  const m=nativeFact.status===200?nativeFact.selectedModel:null;if(m?.id!=='openai/gpt-4o-mini-2024-07-18')throw new Refusal('decision-catalog-unavailable');
  const rates=m.top_provider.pricing;if(rates.currency!=='RUB'||m.context_length!==128000||m.max_completion_tokens!==16384)throw new Refusal('decision-route-metadata-changed');
  const account=load(join(root,'account-and-limits.json'));
  const show=account.find(x=>x.kind==='ollama-model');if(show?.modelMetadata?.limits?.['deepseek_v41.context_length']!==1048576)throw new Refusal('subject-input-ceiling-unqualified');
  const native=fs.readFileSync(join(OLLAMA,'models.generated.ts'),'utf8'),start=native.indexOf('id: "deepseek-v4.1-flash"');
  if(start<0||Number(native.slice(start,start+2400).match(/maxTokens:\s*(\d+)/)?.[1])!==393216)throw new Refusal('subject-output-metadata-changed');
  const routes=[
    {purpose:'subject',provider:'ollama-cloud',model:'deepseek-v4.1-flash',actualModels:['deepseek-v4.1-flash','deepseek-v4.1-flash:1017'],reasoning:'high',endpoint:'https://ollama.com/v1/chat/completions',currency:'USD',inputRate:'0.30',outputRate:'1.20',inputCeiling:1048576,outputCeiling:393216,maxTokens:4096,requestTimeoutMs:60000,priceBasis:'Current official token-priced usage credits; reserve the full provider context and installed native output upper limit, not SDK zeros or subscription assumptions.'},
    {purpose:'evaluator',provider:'polza',model:m.id,actualModels:[m.id,'gpt-4o-mini-2024-07-18'],reasoning:'off',endpoint:'https://polza.ai/api/v1/chat/completions',currency:'RUB',inputRate:rates.prompt_per_million,outputRate:rates.completion_per_million,inputCeiling:128000,outputCeiling:16384,maxTokens:2048,requestTimeoutMs:30000,priceBasis:'Official Polza model pricing in RUB. Full model context/output reservation; highest uncached input rate covers discounted cache reads. No tools/web/search/other billable features.'}
  ];
  const cases=CASES.map(id=>{const c=corpus.cases.find(c=>c.id===id),l=labels.cases.find(c=>c.caseId===id);if(split.groups.find(g=>g.id===c.group)?.split!=='calibration')throw new Refusal('holdout-not-authorized-in-this-increment');return {id,group:c.group,domain:c.domain,expected:l.classification,bucket:l.bucket,sourceDigests:c.sources.map(s=>({id:s.id,sha256:s.sha256,availability:s.availability})),sourceBodiesDigest:digest(stable(c.sources))};});
  if(routes.some(r=>quote(r)*3n>(r.currency==='USD'?3000000000n:20000000000n)))throw new Refusal('resolved-plan-exceeds-authority');
  const pins={};
  for(const n of ['package.json','dist/core/sdk.js','dist/core/model-runtime.js','dist/core/extensions/runner.js','node_modules/@earendil-works/pi-ai/package.json','node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js'])pins['SDK/'+n]=pin(join(REPO,'node_modules/@earendil-works/pi-coding-agent',n));
  for(const n of SOURCES){pins['src/'+n+'.ts']=pin(join(REPO,'src',n+'.ts'));for(const ext of ['.js','.d.ts'])pins['engine/dist/'+n+ext]=pin(join(root,'engine/dist',n+ext));}
  for(const n of ['scripts/collect-k09.mjs','scripts/k09-budget.mjs','test/k09-collector.test.mjs','resources/prompts/engineering-v1.md','resources/prompts/evaluation-v1.schema.json',...['corpus.json','labels.json','split.json','acceptance-plan.json','review-instructions.md','freeze.json'].map(n=>'test/fixtures/k09/v1/'+n)])pins[n]=pin(join(REPO,n));
  for(const [prefix,base,names]of [['ollama',OLLAMA,['index.ts','models.generated.ts','thinking-levels.ts','README.md']],['polza',POLZA,['index.ts','stream.ts','stream-accounting.ts','auth.ts','env.ts','provider.ts','http.ts']]])for(const n of names)pins[prefix+'/'+n]=pin(join(base,n));
  const providerEvidence=Object.fromEntries(['public-provider-facts.json','native-polza-model.json','account-and-limits.json','ollama-quota.json'].map(n=>[n,pin(join(root,n))]));
  const plan={version:'k09-live-calibration-354-v1',baseHead:entry.head,cases,routes,pins,providerEvidence,controllerSupport:Object.fromEntries(['run.py','offline-net.mjs'].map(n=>[n,pin(join(root,n))])),availability:'Non-inference credential checks returned200; Polza balance observed. Current Ollama usage endpoint supplies activity buckets, not a usable credit/quota balance. Entitlement/remaining credits remain UNKNOWN; a route refusal stops without retry/substitution.',limits:{USD:'3',RUB:'20',subjects:3,evaluations:3,totalPhysicalRequests:6,subjectRequestsPerCase:1,evaluatorRequestsPerCase:1,tools:0,retries:0,repairs:0,concurrency:1,caseWorkMs:100000,cleanupMs:10000,caseOuterMs:115000,campaignMs:360000,outerMs:420000,requestBytes:32768,responseBytes:1048576,artifactBytesPerCase:1048576},pipeline:{subject:'Real native AgentSession HIGH, no tools; complete original synthetic materials supplied as data. Final text only; reasoning never persisted.',trigger:'Real native turn_end -> core.before-completion; not a synthetic progress event or invented manual check.',context:'Four frozen original sources, then actual subject final answer as explicitly nonauthoritative reference and native window metadata as evidence. Per-case dynamic bodies are bound before evaluator dispatch.',prompt:'Unchanged engineering-v1 + accepted K09 supplement; canonical schema; questions null.',evaluator:'core.chat with explicit Polza profile, no repair; normal C1 reference/criterion validation.',reaction:'observe/core.record-only; no feedback/escalations/continuation/effects.',score:'Original accepted gates retained; this three-case calibration increment is not held-out promotion or D-39.'},authority:{operator:'354 new USD3 plus separate RUB20, not additive USD1',labels:'Externally admitted Astra347; original nine files immutable',mechanics:'Astra351/352 accepted; reused, not rerun',preRun:'D1 20.1/20.8 and H1 5 require the bound plan, reviewed oracle and operator authority; no additional independent pre-run gate was found for this nonpromotion calibration increment. Final independent acceptance remains downstream.'},identityLimits:{subjectActualRevision:null,evaluatorActualRevision:null,providerAliasesCanChange:true},money:routes.map(r=>({currency:r.currency,maxPerRequest:decimal(quote(r)),maxThreeRequests:decimal(quote(r)*3n),reservationBasis:'Complete model input context plus full native output limit, including reasoning; requested generation limit is smaller.'})),evaluatorChoice:'Existing native Polza provider exposes typesafe/jev as classification with no generative output cap; current accepted resource is generative C1, not typed questions. Choose economical, nonreasoning, dated GPT-4o-mini with authoritative 128k/16k limits and native RUB pricing; no model-comparison campaign.'};
  return {...plan,tupleDigest:digest(stable(plan))};
}
function response(model,result,usage,thinking=false){
  const base={id:'offline-354',object:'chat.completion.chunk',created:1,model},chunks=[];
  if(thinking)chunks.push({...base,choices:[{index:0,delta:{reasoning_content:'K09_REASONING_NOT_CAPTURED_354'},finish_reason:null}]});
  chunks.push({...base,choices:[{index:0,delta:{content:typeof result==='string'?result:JSON.stringify(result)},finish_reason:null}],usage:null});
  chunks.push({...base,choices:[{index:0,delta:{},finish_reason:'stop'}]});chunks.push({...base,choices:[],usage});
  return new Response(chunks.map(x=>'data: '+JSON.stringify(x)+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
}
function controlledProvider(url,init){
  const b=JSON.parse(init.body);
  if(String(url).startsWith('https://ollama.com/'))return Promise.resolve(response(b.model,'A bounded synthetic final assessment from the offline subject. No hidden oracle was supplied.',{prompt_tokens:180,completion_tokens:50,total_tokens:230},true));
  const t=JSON.stringify(b.messages),rule=t.match(/source:requirements:[a-f0-9]+/)?.[0],code=t.match(/source:implementation:[a-f0-9]+/)?.[0];
  const finding=rule&&code?[{id:'mechanical-reference',criterion:'correctness.requirements',status:'suspected',severity:'concern',requirementRefs:[rule],evidenceIds:[code],affectedItems:[code],defectCode:'correctness.requirement-violation',explanation:'Scripted protocol/reference probe, not semantic judgment.',proposedCorrection:null,limitations:[]}]:[];
  return Promise.resolve(response(b.model,{operational:'completed',coverage:{state:'complete',scopeDescription:'mechanical input qualification only',issues:[]},conclusion:finding.length?'findings':'no-supported-finding',findings:finding,scores:[],additionalEvidence:[],dependencies:[],usageAttemptIds:[]},{prompt_tokens:200,completion_tokens:100,total_tokens:300,cost_rub:'0.01000000'}));
}
// Native session entry projection: no original unfiltered session file is ever created.
function sessionArchive(manager){
  const entries=[];
  for(const e of manager.getEntries()){
    if(e.type==='message'){
      const m=e.message;if(!['user','assistant','toolResult','system'].includes(m.role))continue;
      const content=m.role==='assistant'?[{type:'text',text:text(m)}]:typeof m.content==='string'?m.content:(m.content??[]).filter(x=>x.type==='text').map(x=>({type:'text',text:x.text}));
      entries.push({type:e.type,id:e.id,parentId:e.parentId,timestamp:e.timestamp,message:{role:m.role,content,...(m.role==='assistant'?{provider:m.provider,model:m.model,api:m.api,usage:m.usage,stopReason:m.stopReason,timestamp:m.timestamp}:{})}});
    }else if(['model_change','thinking_level_change','usage'].includes(e.type))entries.push(e);
  }
  return [manager.getHeader(),...entries].filter(Boolean).map(x=>JSON.stringify(x)).join('\n')+'\n';
}
async function bounded(promise,ms,code){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Refusal(code)),ms);})]);}finally{clearTimeout(timer);}}
async function caseChild(root,out,id,offline,planPath){
  const plan=load(planPath),workDeadline=Date.now()+plan.limits.caseWorkMs,route=plan.routes[0],project=join(out,'project'),agent=join(out,'agent');fs.mkdirSync(project,{recursive:true});fs.mkdirSync(join(agent,'quality'),{recursive:true});
  process.chdir(project);process.env.PI_CODING_AGENT_DIR=agent;process.env.PI_OLLAMA_WEB_TOOLS='0';process.env.PI_POLZA_ENV_FILE=join(out,'empty-env');fs.writeFileSync(process.env.PI_POLZA_ENV_FILE,'');
  const secretNames=['OLLAMA_API_KEY','POLZA_API_KEY'],keys=Object.fromEntries(secretNames.map(n=>[n,process.env[n]??(offline?'synthetic-354-not-a-credential':'')]));
  if(secretNames.some(n=>!keys[n]))throw new Refusal('selected-key-unavailable');for(const n of secretNames)delete process.env[n];
  const c=load(join(FIXTURE,'corpus.json')).cases.find(c=>c.id===id),record={caseId:id,mode:offline?'OFFLINE_SCRIPTED':'LIVE',tuple:plan.tupleDigest,phase:'materialization',inputs:[],responses:[],SDKInputs:[],createdAt:new Date().toISOString()};
  const ledger=new CampaignLedger(join(dirname(out),'campaign-ledger.json'),plan.tupleDigest);let native=null,guard=null;
  const save=()=>atomic(join(out,'case.json'),record);
  const delegate=offline?controlledProvider:globalThis.fetch.bind(globalThis);
  guard=guardedFetch({routes:plan.routes,ledger,delegate,caseId:()=>id,deadline:workDeadline,secrets:offline?[]:Object.values(keys),onInput:(r,requestId,body)=>{
    if(r.purpose==='evaluator'){
      const delivered=JSON.stringify(JSON.parse(body).messages),contains=s=>delivered.includes(JSON.stringify(s).slice(1,-1));
      record.assessedSources=[...c.sources.map(s=>s.path),'subject-output.txt','native-window.json'].map((path,i)=>{const p=join(project,path);return fs.existsSync(p)?{path,...pin(p),required:i<4,providerBodyContainsCompleteBody:contains(fs.readFileSync(p,'utf8'))}:{path,available:false,required:i<4};});
      const engineering=fs.readFileSync(join(REPO,'resources/prompts/engineering-v1.md'),'utf8'),supplement=fs.readFileSync(join(FIXTURE,'review-instructions.md'),'utf8'),schema=JSON.stringify(load(join(REPO,'resources/prompts/evaluation-v1.schema.json')));
      record.resourceDelivery={engineering:contains(engineering),supplement:contains(supplement),schema:contains(schema)};
      if(record.assessedSources.some(s=>s.required&&!s.providerBodyContainsCompleteBody)||Object.values(record.resourceDelivery).some(v=>!v))throw new Refusal('actual-selected-body-or-resource-missing');
    }
    const n=record.inputs.length+1;fs.writeFileSync(join(out,`input-${n}.json`),body);record.inputs.push({purpose:r.purpose,id:requestId,bytes:Buffer.byteLength(body),sha256:digest(body),at:new Date().toISOString()});save();
  }});globalThis.fetch=guard.fetch;
  try{
    for(const s of c.sources)if(s.availability==='provided')fs.writeFileSync(join(project,s.path),s.body);
    fs.writeFileSync(join(project,'k09-review-instructions.md'),fs.readFileSync(join(FIXTURE,'review-instructions.md')));
    fs.writeFileSync(join(out,'grader-sentinel'),'K09_PRIVATE_354_SENTINEL');
    const ids=['task','requirements','implementation','window'];const sources=Object.fromEntries(c.sources.map((s,i)=>[ids[i],{uris:['project:'+s.path],role:s.role,required:true}]));
    sources['subject-hypothesis']={uris:['project:subject-output.txt'],role:'reference',required:false};sources['native-window']={uris:['project:native-window.json'],role:'evidence',required:false};
    const decision=plan.routes[1];
    const config={schemaVersion:1,enabled:true,mode:'observe',sources,modelProfiles:{decision:{provider:'polza',model:decision.model,reasoning:'off',requestTimeoutMs:30000,maxAttempts:1,retryDelayMs:0,maxOutputTokens:2048,price:{currency:'RUB',revision:plan.tupleDigest,inputPerMillion:decision.inputRate,outputPerMillion:decision.outputRate},requiredInputs:['text']}},permissions:{modelProfiles:['decision']},contexts:{case:{providers:[{id:'files',use:'core.files',options:{sourceIds:Object.keys(sources)}}],requiredCoverage:'partial',maxBytes:32768,maxEstimatedTokens:12000}},prompts:{case:{use:'core.prompt-files',options:{instructions:['builtin:engineering-v1.md','project:k09-review-instructions.md'],resultSchema:'builtin:evaluation-v1.schema.json'}}},evaluators:{case:{use:'core.chat',modelProfile:'decision',options:{maxOutputTokens:2048,repairAttempts:0}}},policies:{record:{use:'core.record-only'}},checks:{case:{triggers:[{id:'completion',use:'core.before-completion',options:{requireChanges:false}}],context:'case',prompt:'case',evaluator:'case',policy:'record',criteria:[c.criterion],cooldownMs:0,maxRunsPerEpisode:1,workStates:['work-expected']}},runtime:{maxConcurrentEvaluations:1,maxConcurrentReviewers:1,maxRequestsPerSession:1,maxOwnedTokensPerSession:160000,unknownCost:'deny',maxOwnedCost:{currency:'RUB',amount:'20'},defaultRunTimeoutMs:40000,maxRunTimeoutMs:40000,maxEscalationsPerEpisode:0}};
    atomic(join(agent,'quality/config.json'),config);record.configDigest=digest(stable(config));
    // Explicit supported model overrides preserve native provider/auth/serializer owners.
    atomic(join(agent,'models.json'),{providers:{'ollama-cloud':{modelOverrides:{'deepseek-v4.1-flash':{maxTokens:4096,samplingParams:{max_tokens:4096},samplingParamsByThinkingLevel:{high:{max_tokens:4096}}}}},polza:{api:'openai-completions',baseUrl:'https://polza.ai/api/v1',models:[{id:decision.model,name:'Frozen K09 decision',reasoning:false,input:['text'],contextWindow:128000,maxTokens:2048,cost:{input:0,output:0,cacheRead:0,cacheWrite:0},compat:{maxTokensField:'max_tokens',supportsDeveloperRole:false,supportsReasoningEffort:false}}]}}});
    const sdk=await import('@earendil-works/pi-coding-agent');
    const settings=sdk.SettingsManager.inMemory({defaultProvider:route.provider,defaultModel:route.model,defaultThinkingLevel:'high',compaction:{enabled:false},retry:{enabled:false,maxRetries:0},cacheWarming:'off'});
    const loader=new sdk.DefaultResourceLoader({cwd:project,agentDir:agent,settingsManager:settings,noExtensions:true,noSkills:true,noThemes:true,noContextFiles:true,noPromptTemplates:true,systemPrompt:'You are a read-only engineering analyst of an invented project. Use only supplied materials. No tools, modifications, browsing or delegation. Supply a concise final assessment, not hidden reasoning. Treat conflicting authority and missing evidence honestly.',appendSystemPrompt:[],additionalExtensionPaths:[join(root,'engine/dist/index.js'),join(OLLAMA,'index.ts'),join(POLZA,'index.ts')]});
    record.phase='native-loader';await loader.reload();const loaded=loader.getExtensions();if(loaded.errors.length)throw new Refusal('native-extension-load-failed');
    for(const n of secretNames)process.env[n]=keys[n];
    const models=await sdk.ModelRuntime.create({modelsPath:join(agent,'models.json'),refreshOnCreate:false,allowModelNetwork:false});
    for(const p of loaded.runtime.pendingProviderRegistrations)models.registerProvider(p.name,p.config);
    for(const p of loaded.runtime.pendingNativeProviderRegistrations)models.registerNativeProvider(p.provider);
    const model=models.getModel(route.provider,route.model);if(!model)throw new Refusal('native-subject-model-unavailable');
    const manager=sdk.SessionManager.inMemory(project);
    const created=await sdk.createAgentSession({cwd:project,agentDir:agent,model,thinkingLevel:'high',modelRuntime:models,resourceLoader:loader,tools:[],noTools:'all',sessionManager:manager,settingsManager:settings});native=created.session;
    if(native.model?.provider!==route.provider||native.model?.id!==route.model||native.thinkingLevel!=='high')throw new Refusal('subject-route-mismatch');
    let status=null;const notices=[];record.extensionErrors=[];
    await native.bindExtensions({mode:'rpc',onError:e=>{record.extensionErrors.push({event:e.event});},uiContext:{notify:msg=>{try{const j=JSON.parse(msg);if(j.engine)status=j;}catch{}},setStatus:()=>{},setWorkingMessage:()=>{},setTitle:()=>{},setWidget:()=>{},setFooter:()=>{},setHeader:()=>{},setEditorText:()=>{},getEditorText:()=>'',custom:async()=>undefined,confirm:async()=>false,select:async()=>undefined,input:async()=>undefined}});
    const inspectStatus=async()=>{const cmd=native.extensionRunner.getCommand('quality');if(!cmd)throw new Refusal('quality-command-not-bound');await cmd.handler('status',native.extensionRunner.createCommandContext());};
    await inspectStatus();
    record.preflight={status,decisionModelAvailable:Boolean(models.getModel('polza',decision.model)),subjectAuth:models.hasConfiguredAuth('ollama-cloud'),decisionAuth:models.hasConfiguredAuth('polza')};save();
    if(!status||status.configuration.rejection!==null||!models.getModel('polza',decision.model))throw new Refusal('managed-pre-run-configuration-not-ready');
    record.initialStatus=status;
    record.subjectRoute={provider:native.model.provider,model:native.model.id,reasoning:native.thinkingLevel,sessionId:native.sessionId};
    native.subscribe(e=>{
      if(e.type==='message_end'&&e.message?.role==='assistant'){
        const answer=text(e.message);
        if(Object.values(keys).some(k=>answer.includes(k))){ledger.state.closed='secret-response-safety-stop';ledger.save();guard.close();throw new Refusal('secret-response-capture-refused');}
        record.responses.push({purpose:'subject',provider:e.message.provider,model:e.message.model,stopReason:e.message.stopReason,usage:e.message.usage,at:new Date().toISOString()});
        if(answer)fs.writeFileSync(join(project,'subject-output.txt'),'Actual subject final assessment: nonauthoritative hypothesis, not a requirement or grading oracle.\n'+answer);
        atomic(join(project,'native-window.json'),{origin:'actual-native-Pi-354',subjectResponseObserved:true,stopReason:e.message.stopReason,at:new Date().toISOString(),providedSourceDigests:c.sources.map(s=>({id:s.id,sha256:s.sha256}))});save();
      }
    });
    // Read-only SDK observers: original argument objects delegate unchanged.
    for(const method of ['complete','streamSimple']){
      const original=models[method].bind(models);
      models[method]=function(...args){
        const raw=JSON.stringify(args[1]);
        if(Object.values(keys).some(k=>raw.includes(k))||raw.includes('K09_PRIVATE_354_SENTINEL')||raw.includes('K09_REASONING_NOT_CAPTURED_354'))throw new Refusal('private-sdk-input-refused');
        const name=`sdk-input-${record.SDKInputs.length+1}.json`;fs.writeFileSync(join(out,name),raw);record.SDKInputs.push({method,provider:args[0].provider,model:args[0].id,file:name,sha256:digest(raw)});save();
        const result=original(...args);
        if(method!=='complete')return result;
        return result.then(a=>{record.responses.push({purpose:'evaluator',provider:a.provider,model:a.model,stopReason:a.stopReason,usage:a.usage,at:new Date().toISOString()});const answer=text(a);if(Object.values(keys).some(k=>answer.includes(k))){ledger.state.closed='secret-response-safety-stop';ledger.save();guard.close();throw new Refusal('secret-response-capture-refused');}fs.writeFileSync(join(out,'evaluator-output.txt'),answer);save();return a;});
      };
    }
    const prompt='Inspect this supplied synthetic implementation against its supplied current task and requirements. Prior synthetic command outcomes are declared simulations, not operations you performed. Do not claim fresh tests or edits. Briefly state a scoped final assessment and limitations.\n\n'+c.sources.map(s=>`[supplied ${s.path} role ${s.role} availability ${s.availability}]\n${s.body??'(unavailable)'}`).join('\n\n');
    record.phase='subject';save();if(Date.now()>=workDeadline)throw new Refusal('case-work-deadline');await bounded(native.prompt(prompt),Math.min(65000,workDeadline-Date.now()),'subject-work-deadline');
    record.phase='evaluation';const deadline=Math.min(Date.now()+42000,workDeadline);
    do{await inspectStatus();if(status?.diagnostics?.recentEvents?.some(e=>e.event==='quality.check.settled'))break;await delay(25);}while(Date.now()<deadline);
    if(!status?.diagnostics?.recentEvents?.some(e=>e.event==='quality.check.settled'))throw new Refusal('managed-assessment-not-settled');
    record.status=status;await bounded(guard.drain(),10000,'usage-observer-pending');
    let archive=sessionArchive(manager);for(const key of Object.values(keys))archive=archive.split(key).join('<redacted>');fs.writeFileSync(join(out,'native-session.sanitized.jsonl'),archive);record.nativeSessionCapture={source:'actual native in-memory SessionManager',reasoning:'omitted before first persistent write',notPristineTranscript:true};
    const rows=[];const logs=join(agent,'quality/logs');
    async function scan(dir){for(const d of await fsp.readdir(dir,{withFileTypes:true}).catch(()=>[])){const p=join(dir,d.name);if(d.isDirectory())await scan(p);else if(d.isFile()&&d.name.endsWith('.jsonl'))for(const line of fs.readFileSync(p,'utf8').split('\n').filter(Boolean))rows.push(JSON.parse(line));}}
    await native.extensionRunner.getCommand('quality').handler('stop',native.extensionRunner.createCommandContext());await bounded(native.extensionRunner.emit({type:'session_shutdown',reason:'quit'}),10000,'shutdown-pending');await inspectStatus();record.retiredStatus=status;native.dispose();native=null;await scan(logs);
    record.observedActionDispatches=rows.filter(x=>x.event==='quality.action.dispatched').length;
    record.canonical=rows.filter(x=>x.event==='quality.assessment.result').map(x=>x.fields.data);record.manifests=rows.filter(x=>x.event==='quality.context.manifest'||x.event==='quality.context.manifest-part');record.O1=rows;
    if(record.extensionErrors.length)throw new Refusal('extension-operation-error');
    if(record.canonical.length!==1||record.inputs.filter(x=>x.purpose==='subject').length!==1||record.inputs.filter(x=>x.purpose==='evaluator').length!==1)throw new Refusal('connected-observation-incomplete');
    if(record.observedActionDispatches!==0)throw new Refusal('unexpected-effect-observed');
    record.accounting=ledger.state.attempts.filter(r=>r.caseId===id);record.refusedNetworkRequests=guard.refused();record.outcome=ledger.state.closed?'BLOCKED_UNKNOWN_OR_LIMIT':'COLLECTED';ledger.caseResult(id,record.outcome);record.phase='finished';save();
    if(ledger.state.closed)throw new Refusal('unknown-billing-or-ceiling-halts-campaign');
  }catch(e){record.failure=e instanceof Refusal?e.code:'native-operation-failed';record.phase='failed';record.outcome='FAILED_OR_BLOCKED';save();throw e;}
  finally{if(native){try{await bounded(native.abort(),5000,'abort-pending');await bounded(native.extensionRunner.emit({type:'session_shutdown',reason:'quit'}),5000,'shutdown-pending');native.dispose();}catch{record.cleanup='unresolved';}}guard.close();ledger.close();save();}
}
async function driver(root,out,offline){
  const plan=offline?makePlan(root):load(join(root,'experiment-plan.json'));
  if(!offline&&plan.tupleDigest!==makePlan(root).tupleDigest)throw new Refusal('frozen-experiment-tuple-mismatch');
  if(!offline){const account=load(join(root,'account-and-limits.json'));if(account.find(x=>x.kind==='ollama-availability')?.status!==200||account.find(x=>x.kind==='polza-balance')?.status!==200)throw new Refusal('account-preflight-not-established');}
  fs.mkdirSync(out,{recursive:true});const pp=join(out,'protocol.json');if(fs.existsSync(pp)&&load(pp).tupleDigest!==plan.tupleDigest)throw new Refusal('resume-tuple-mismatch');atomic(pp,plan);
  const firstStart=fs.existsSync(join(out,'summary.json'))?load(join(out,'summary.json')).startedAt:new Date().toISOString();
  const deadline=Date.parse(firstStart)+plan.limits.campaignMs;
  const summary={mode:offline?'OFFLINE_SCRIPTED':'LIVE',tuple:plan.tupleDigest,inventory:plan.cases.map(c=>({...c,disposition:'not-run'})),children:[],startedAt:firstStart};atomic(join(out,'summary.json'),summary);
  for(const c of plan.cases){
    const dir=join(out,c.id);if(fs.existsSync(join(dir,'case.json'))){const prior=load(join(dir,'case.json'));if(prior.outcome==='COLLECTED'){summary.inventory.find(x=>x.id===c.id).disposition='retained-prior-collected';continue;}throw new Refusal('uncertain-case-is-not-retried');}
    if(Date.now()+plan.limits.cleanupMs>=deadline)throw new Refusal('campaign-deadline-no-renewal');
    fs.mkdirSync(dir);const home=join(dir,'home');fs.mkdirSync(home);for(const n of ['appdata','localappdata','temp','agent'])fs.mkdirSync(join(home,n));for(const n of ['git-empty','npm-empty'])fs.writeFileSync(join(home,n),'');
    const env={};for(const k of ['PATH','Path','SystemRoot','WINDIR','COMSPEC','PATHEXT','SystemDrive'])if(process.env[k])env[k]=process.env[k];
    Object.assign(env,{HOME:home,USERPROFILE:home,APPDATA:join(home,'appdata'),LOCALAPPDATA:join(home,'localappdata'),TEMP:join(home,'temp'),TMP:join(home,'temp'),PI_CODING_AGENT_DIR:join(home,'agent'),GIT_CONFIG_SYSTEM:join(home,'git-empty'),GIT_CONFIG_GLOBAL:join(home,'git-empty'),GIT_CONFIG_NOSYSTEM:'1',GIT_CEILING_DIRECTORIES:dir,NPM_CONFIG_USERCONFIG:join(home,'npm-empty'),NPM_CONFIG_GLOBALCONFIG:join(home,'npm-empty'),QE_NATIVE_OUT:dir});
    if(!offline)for(const k of ['OLLAMA_API_KEY','POLZA_API_KEY'])env[k]=process.env[k];
    const p=spawn(process.execPath,[...(offline?['--import',pathToFileURL(join(root,'offline-net.mjs')).href]:[]),SELF,'--case',c.id,'--root',root,'--out',dir,'--protocol',pp,...(offline?['--scripted']:[])],{cwd:home,env,stdio:['ignore','pipe','pipe']});let killed=false,exit=null,stdoutEnd=false,stderrEnd=false;const stdout=[],stderr=[];
    p.stdout.on('data',b=>stdout.push(b));p.stderr.on('data',b=>stderr.push(b));p.stdout.on('end',()=>stdoutEnd=true);p.stderr.on('end',()=>stderrEnd=true);p.on('exit',code=>exit=code);
    const timer=setTimeout(()=>{killed=true;p.kill();},Math.min(plan.limits.caseOuterMs,deadline-Date.now()-plan.limits.cleanupMs));await new Promise((ok,fail)=>{p.once('close',ok);p.once('error',fail);});clearTimeout(timer);
    // Child prints safe code summaries only; mask selected keys again before any write.
    let o=Buffer.concat(stdout).toString(),e=Buffer.concat(stderr).toString();for(const k of ['OLLAMA_API_KEY','POLZA_API_KEY'])if(process.env[k]){o=o.split(process.env[k]).join('<redacted>');e=e.split(process.env[k]).join('<redacted>');}fs.writeFileSync(join(dir,'stdout.txt'),o);fs.writeFileSync(join(dir,'stderr.txt'),e);
    const n={pid:p.pid,exit,closeObserved:true,stdoutEnd,stderrEnd,watchdogKill:killed};atomic(join(dir,'native.json'),n);summary.children.push(n);summary.inventory.find(x=>x.id===c.id).disposition=exit===0?'collected':'failed-or-blocked';atomic(join(out,'summary.json'),summary);
    if(exit!==0||killed)throw new Refusal('case-stopped-no-retry');
  }
  const l=load(join(out,'campaign-ledger.json'));summary.attempts=l.attempts;const reopened=new CampaignLedger(join(out,'campaign-ledger.json'),plan.tupleDigest);try{summary.budgets={USD:reopened.totals('USD'),RUB:reopened.totals('RUB')};}finally{reopened.close();}summary.finishedAt=new Date().toISOString();atomic(join(out,'summary.json'),summary);
  console.log(JSON.stringify({mode:summary.mode,cases:summary.children.length,providerRequests:l.attempts.filter(r=>r.dispatchObservedAt).length,unknown:l.attempts.filter(r=>r.status==='unknown').length,tuple:plan.tupleDigest}));
}
async function main(){
  const argv=process.argv.slice(2),value=k=>argv[argv.indexOf(k)+1],root=resolve(value('--root'));
  if(argv.includes('--plan-only')){console.log(JSON.stringify(makePlan(root),null,2));return;}
  if(argv.includes('--case')){await caseChild(root,resolve(value('--out')),value('--case'),argv.includes('--scripted'),resolve(value('--protocol')));return;}
  if(argv.includes('--offline')){await driver(root,resolve(value('--out')),true);return;}
  if(argv.includes('--live')){await driver(root,join(root,'live-campaign'),false);return;}
  throw new Refusal('explicit-mode-required');
}
if(process.argv[1]&&resolve(process.argv[1])===SELF)main().catch(e=>{console.error(JSON.stringify({status:'STOPPED',code:e instanceof Refusal?e.code:'collector-preparation-or-operation-error'}));process.exitCode=2;});
