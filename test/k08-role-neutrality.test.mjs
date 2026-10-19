// K08-B.12/B.13/T07/E.04: actual local SDK display labels, scope/grants, owned reviewer and primary cadence.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, copyFile, readdir, realpath, rm, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import test from "node:test";

// The original required observation predicate is retained unchanged. New source
// controls additionally exercise the independently packed example, not counters.
const PACKAGE_ID = "fixture.independent-extension", CONTEXT_ID = "fixture.note", EVALUATOR_ID = "fixture.audit-evaluator", POLICY_ID = "fixture.audit-policy", ACTION_ID = "fixture.audit-file";
const ROLE_IDS = ["fixture.burst-tools", CONTEXT_ID, EVALUATOR_ID, POLICY_ID, ACTION_ID, "fixture.mutating-sink", "fixture.projected-sink", "fixture.stalled-sink", "fixture.observation"];
const RULE = "Repeated reads are evidence for investigation, not proof of an implementation defect.";
const TASK = "Assess the neutral synthetic work. Investigation alone is not a defect.";


const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const identity = async path => { const bytes = await readFile(path); return { bytes: bytes.length, sha256: sha(bytes) }; };
const json = async path => JSON.parse(await readFile(path, "utf8"));
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf8");
const inside = (root, path) => { const name = relative(root, path); return name !== ".." && !name.startsWith("..\\") && !name.startsWith("../") && !isAbsolute(name); };

function isolatedEnvironment(root) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "SYSTEMDRIVE"].includes(key)));
  Object.assign(env, {
    HOME: join(root, "home"), USERPROFILE: join(root, "home"), APPDATA: join(root, "appdata"), LOCALAPPDATA: join(root, "localappdata"), PI_CODING_AGENT_DIR: join(root, "agent"),
    TMPDIR: join(root, "tmp"), TEMP: join(root, "tmp"), TMP: join(root, "tmp"),
    GIT_CEILING_DIRECTORIES: root, GIT_CONFIG_GLOBAL: join(root, "empty.gitconfig"), GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0",
    npm_config_userconfig: join(root, "user.npmrc"), npm_config_globalconfig: join(root, "global.npmrc"), npm_config_cache: join(root, "npm-cache"), npm_config_offline: "true",
  });
  return env;
}

async function prepareEnvironment(root) {
  const env = isolatedEnvironment(root);
  for (const key of ["HOME", "APPDATA", "LOCALAPPDATA", "PI_CODING_AGENT_DIR", "TMP", "npm_config_cache"]) await mkdir(env[key], { recursive: true });
  for (const name of ["empty.gitconfig", "user.npmrc", "global.npmrc"]) await writeFile(join(root, name), "", "utf8");
  return env;
}

// Actual exit, native close and both pipe ends are distinct from an assertion.
async function runNative(out, command, cwd, env, timeoutMs = 20_000) {
  await mkdir(out, { recursive: true });
  const receipt = { command, cwd, environmentKeys: Object.keys(env).sort(), timeoutMs, startUtc: new Date().toISOString() };
  await save(join(out, "command.json"), receipt);
  let stdout = "", stderr = "", stdoutEnd = false, stderrEnd = false, nativeExit = null, timedOut = false, spawnError = null;
  const started = performance.now();
  const child = spawn(command[0], command.slice(1), { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", bytes => { stdout += String(bytes); });
  child.stderr.on("data", bytes => { stderr += String(bytes); });
  child.stdout.once("end", () => { stdoutEnd = true; });
  child.stderr.once("end", () => { stderrEnd = true; });
  child.once("exit", (code, signal) => { nativeExit = { code, signal }; });
  child.once("error", error => { spawnError = error.code; });
  const timer = setTimeout(() => {
    timedOut = true;
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { env, stdio: "ignore" });
      killer.on("error", () => {});
    } else child.kill("SIGKILL");
  }, timeoutMs);
  const closed = await new Promise(resolvePromise => child.once("close", (code, signal) => resolvePromise({ code, signal })));
  clearTimeout(timer);
  Object.assign(receipt, { pid: child.pid, exit: closed.code, signal: closed.signal, nativeExit, stdoutEnd, stderrEnd, timedOut, spawnError, elapsedMs: performance.now() - started });
  await writeFile(join(out, "stdout.txt"), stdout, "utf8");
  await writeFile(join(out, "stderr.txt"), stderr, "utf8");
  await save(join(out, "exit.json"), receipt);
  assert.equal(spawnError, null, "the actual native child starts");
  assert.equal(timedOut, false, "an outer timeout is not a successful operation");
  assert.deepEqual(nativeExit, closed, "native exit and close both returned");
  assert.equal(stdoutEnd && stderrEnd, true, "both native pipes ended");
  return { receipt, stdout, stderr };
}

function tarInventory(bytes) {
  const tar = gunzipSync(bytes), files = {};
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const field = (start, end) => header.subarray(start, end).toString("utf8").replace(/\0.*$/su, "");
    const prefix = field(345, 500), name = (prefix ? prefix + "/" : "") + field(0, 100);
    const size = Number.parseInt(field(124, 136).trim() || "0", 8), kind = field(156, 157);
    assert.ok(Number.isSafeInteger(size) && size >= 0);
    assert.ok(name.startsWith("package/") && !name.split("/").includes(".."));
    if (kind !== "5") {
      assert.ok(kind === "" || kind === "0", "no archive links or nonregular payloads");
      const body = tar.subarray(offset + 512, offset + 512 + size);
      assert.equal(body.length, size);
      files[name.slice(8)] = { bytes: size, sha256: sha(body) };
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

const npmCommand = (...args) => {
  const cli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  assert.equal(existsSync(cli), true, "use the existing npm CLI shipped with the selected native Node");
  return [process.execPath, cli, ...args];
};

async function packageInputs(source) {
  const manifest = await json(join(source, "package.json"));
  assert.deepEqual(manifest.files, ["dist", "resources", "examples", "README.md", "THIRD_PARTY_NOTICES.md"], "copy only the declared public package surface, never a checkout snapshot");
  const payload = {};
  const visit = async name => {
    for (const entry of await readdir(join(source, name), { withFileTypes: true })) {
      const path = join(name, entry.name);
      assert.equal(entry.isSymbolicLink(), false, "published inputs cannot escape through a link");
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) payload[path.replaceAll("\\", "/")] = await identity(join(source, path));
    }
  };
  for (const name of ["package.json", "README.md", "THIRD_PARTY_NOTICES.md"]) payload[name] = await identity(join(source, name));
  await visit("dist"); await visit("resources"); await visit("examples");
  const peer = await realpath(join(source, "node_modules", "@earendil-works", "pi-coding-agent"));
  const yaml = await realpath(join(source, "node_modules", "yaml"));
  const sdkManifest = await json(join(peer, "package.json")), yamlManifest = await json(join(yaml, "package.json"));
  assert.equal(sdkManifest.version, manifest.devDependencies["@earendil-works/pi-coding-agent"]);
  assert.equal(yamlManifest.version, manifest.dependencies.yaml);
  return { payload, hostSdk: { path: peer, version: sdkManifest.version, metadata: await identity(join(peer, "package.json")) }, existingYaml: { path: yaml, version: yamlManifest.version, metadata: await identity(join(yaml, "package.json")) } };
}

async function roleChild({root,consumer,scenario,roleLabel,mirror}) {
  assert.equal(existsSync(mirror),false,'no source mirror during installed execution');
  const reviewer=scenario==='reviewer-origin', denied=scenario==='effect-denied', foreign=scenario==='scope-denied';
  const report={scenario,roleLabel,providerCalls:[],observations:[],snapshots:[],primaryReads:[],effects:{sendMessage:0,sendUserMessage:0,appendEntry:0,abort:0},extensionErrors:[],pendingProviders:0};
  const messages=[],captured=new Map();let runner=null,control=null,status=null,stopped=false,failure=null,off=null,handle=null,endpoint=null;
  const files=async dir=>{const result=[];for(const e of await readdir(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())result.push(...await files(p));else if(e.isFile())result.push(p);}return result;};
  const until=async(read,accept,label)=>{const end=Date.now()+6000;do{const v=await read();if(accept(v))return v;await new Promise(r=>setTimeout(r,10));}while(Date.now()<end);throw Error('T07 deadline: '+label);};
  const capture=value=>{report.snapshots.push(value);for(const e of value.diagnostics.recentEvents)captured.set(e.eventId,e);return value;};
  const complete={operational:'completed',coverage:{state:'complete',scopeDescription:'Actual independently packaged context and scoped local read.',issues:[]},conclusion:'no-supported-finding',findings:[],scores:[],additionalEvidence:[],dependencies:[],usageAttemptIds:[]};
  try {
    const agent=process.env.PI_CODING_AGENT_DIR,project=join(root,'project'),destination=join(root,'audit.json');await mkdir(project);await mkdir(join(agent,'quality'));
    await writeFile(join(project,'work.txt'),'K08_ROLE_PRIMARY_READ_CANARY\nordinary bounded local work\n');
    await writeFile(join(project,'owner-notes.md'),'K08_ROLE_REVIEW_READ_CANARY\nRead this scoped synthetic evidence once.\n');
    const contract=import.meta.resolve('pi-quality-engine/contracts'),before=await files(agent);await import('pi-quality-engine/contracts');assert.deepEqual(await files(agent),before);
    const sdk=await import('@earendil-works/pi-coding-agent');report.sdkUrl=import.meta.resolve('@earendil-works/pi-coding-agent');report.contract={url:contract,inert:true,...await identity(fileURLToPath(contract))};
    const config={schemaVersion:1,enabled:true,mode:'advise',
      observationSources:{fixture:{use:'fixture.observation',options:{}}},
      modelProfiles:{scripted:{provider:'qe-k08-role-scripted',model:'role-1',maxOutputTokens:256,price:'unknown'}},permissions:{modelProfiles:['scripted'],actions:denied?[]:[ACTION_ID]},
      prompts:{audit:{use:'core.prompt-files',options:{instructions:['builtin:repetition-v1.md']}}},
      contexts:{work:{providers:[{id:'note',use:CONTEXT_ID},{id:'task',use:'core.task'}]}},
      evaluators:{audit:{use:reviewer?'core.pi-session':EVALUATOR_ID,modelProfile:'scripted',options:reviewer?{tools:['read'],allowProjectReads:true,maxModelRequests:2,maxToolCalls:2,maxOutputTokens:256,maxAdditionalReadBytes:1024,timeoutMs:5000,repairAttempts:0}:{maxOutputTokens:256,...(foreign?{requestRun:'foreign-run'}:{})}},counter:{use:'core.repeated-tools'}},
      policies:{audit:{use:POLICY_ID,options:{destination:pathToFileURL(destination).href}},record:{use:'core.record-only'}},
      checks:{audit:{triggers:[{id:'signal',use:'fixture.burst-tools',options:{count:2}},{id:'origin',use:'role-test.origin-probe',options:{}}],context:'work',prompt:'audit',evaluator:'audit',policy:'audit',cooldownMs:0,maxRunsPerEpisode:1,criteria:['efficiency.repetition'],workStates:['work-expected']},cadence:{triggers:[{id:'two',use:'core.every-tools',options:{count:2}}],context:'work',prompt:'audit',evaluator:'counter',policy:'record',cooldownMs:0,maxRunsPerEpisode:1,criteria:['efficiency.repetition'],workStates:['work-expected']}}};
    await save(join(agent,'quality/config.json'),config);report.configuration=structuredClone(config);
    const probe=pi=>{let sid=null;const accept=value=>{if(value?.apiMajor!==1||value.observedSessionId!==sid||endpoint!==null)return;endpoint=value;const result=value.register({id:'role-test.origin-package',version:'0.1.0',baseUri:pathToFileURL(root+'/').href,resources:{},components:[{id:'role-test.origin-probe',apiMajor:1,kind:'trigger',requiredCapabilities:[],diagnosticCodes:[],optionsSchema:{type:'object',additionalProperties:false},initialState:()=>({}),update(_opts,input){if(input.observation){const o=input.observation;report.observations.push({id:o.id,kind:o.kind,scope:structuredClone(o.scope),origin:structuredClone(o.origin)});}return {state:input.state,intent:null,nextDueMonoMs:null};}}]});assert.equal(result.ok,true);handle=result.value;};pi.on('session_start',(_event,ctx)=>{sid=ctx.sessionManager.getSessionId();off=pi.events.on('quality.registry.available.v1',accept);pi.events.emit('quality.registry.query.v1',{apiMajor:1,observedSessionId:sid,reply:accept});});pi.on('session_shutdown',()=>{off?.();off=null;handle?.dispose();});};
    const paths=[];for(const name of ['pi-quality-engine','qe-independent-fixture']){const dir=join(consumer,'node_modules',name),m=await json(join(dir,'package.json')),p=resolve(dir,m.pi.extensions[0]);assert.ok(inside(dir,p));paths.push(p);}
    const loader=new sdk.DefaultResourceLoader({cwd:project,agentDir:agent,settingsManager:sdk.SettingsManager.inMemory(),noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,additionalExtensionPaths:paths,extensionFactories:[probe]});await loader.reload();const loaded=loader.getExtensions();assert.deepEqual(loaded.errors,[]);
    const models=await sdk.ModelRuntime.create({authPath:join(root,'owned-empty-auth.json'),modelsPath:null,modelsStorePath:join(root,'models-cache.json'),refreshOnCreate:false,allowModelNetwork:false});
    models.registerProvider('qe-k08-role-scripted',{name:'bounded local role-neutrality fixture',api:'qe-role-api',apiKey:'fixture-not-credential',baseUrl:'http://127.0.0.1:9/not-used',models:[{id:'role-1',name:'role fixture',api:'qe-role-api',input:['text'],contextWindow:32768,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}],streamSimple(model,input,opts){
      const delivered=JSON.parse(JSON.stringify(input));let content,stopReason='stop';
      if(reviewer){content=[report.providerCalls.length===0?{type:'toolCall',id:'review-read-1',name:'read',arguments:{path:'owner-notes.md'}}:{type:'toolCall',id:'review-submit-1',name:'submit_result',arguments:complete}];stopReason='toolUse';}
      else content=[{type:'text',text:JSON.stringify(complete)}];
      const call={model:{provider:model.provider,id:model.id,api:model.api},input:delivered,maxTokens:opts?.maxTokens,returnedPhysically:false};report.providerCalls.push(call);report.pendingProviders++;
      const message={role:'assistant',content,api:model.api,provider:model.provider,model:model.id,usage:{input:120,output:30,cacheRead:0,cacheWrite:0,totalTokens:150,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason,timestamp:Date.now()};
      const finish=async()=>{if(!call.returnedPhysically){call.returnedPhysically=true;report.pendingProviders--;}return message;};return{async *[Symbol.asyncIterator](){yield{type:'start',partial:{...message,content:[]}};await finish();yield{type:'done',reason:stopReason,message};},result:finish};
    }});
    const manager=sdk.SessionManager.inMemory(project);manager.appendSessionInfo(roleLabel);report.sdkSession={id:manager.getSessionId(),label:manager.getSessionName(),header:manager.getHeader()};assert.equal(report.sdkSession.label,roleLabel);
    runner=new sdk.ExtensionRunner(loaded.extensions,loaded.runtime,project,manager,new sdk.ModelRegistry(models));const noop=()=>{},effects=report.effects;
    runner.bindCore({sendMessage:()=>effects.sendMessage++,sendUserMessage:()=>effects.sendUserMessage++,appendEntry:()=>effects.appendEntry++,setSessionName:name=>manager.appendSessionInfo(name),getSessionName:()=>manager.getSessionName(),setLabel:noop,getActiveTools:()=>[],getAllTools:()=>[],getSettings:()=>({}),setActiveTools:noop,refreshTools:noop,getCommands:()=>[],setModel:noop,getThinkingLevel:()=> 'off',setThinkingLevel:noop},{getModel:()=>undefined,getScopedModels:()=>[],isIdle:()=>true,isProjectTrusted:()=>true,getSignal:()=>undefined,abort:()=>effects.abort++,hasPendingMessages:()=>false,shutdown:noop,getContextUsage:()=>undefined,compact:noop,getSystemPrompt:()=>''});
    runner.setUIContext({...runner.getUIContext(),notify:m=>messages.push(m)},'rpc');runner.onError(e=>report.extensionErrors.push({event:e.event,error:String(e.error)}));report.loadedPaths=runner.getExtensionPaths();assert.ok(paths.every(p=>report.loadedPaths.map(resolvePath=>resolve(resolvePath)).includes(resolve(p))));
    const quality=runner.getCommand('quality'),lifecycle=runner.getCommand('fixture-lifecycle');assert.ok(quality&&lifecycle);
    status=async()=>{await quality.handler('status',runner.createCommandContext());return capture(JSON.parse(messages.at(-1)));};control=async text=>{await lifecycle.handler(text,runner.createCommandContext());return JSON.parse(messages.at(-1));};
    await runner.emit({type:'session_start',reason:'startup'});await until(()=>control('status'),v=>v.current?.ready?.ok===true,'actual independent package ready');assert.equal((await handle.ready).ok,true);
    await quality.handler('reload',runner.createCommandContext());await until(status,v=>v.checks.detail.every(c=>c.state==='active'),'actual current bindings and approved action declaration');await until(()=>control('status'),v=>v.currentSource?.startReturned===true,'public configured observation start');
    await runner.emit({type:'input',text:TASK,source:'interactive'});
    const readTool=sdk.createReadTool(project);const primaryRead=async ordinal=>{const id='primary-'+ordinal,args={path:'work.txt'};await runner.emit({type:'tool_execution_start',toolCallId:id,toolName:'read',args});const result=await readTool.execute(id,args,new AbortController().signal);report.primaryReads.push({id,result});await runner.emit({type:'tool_execution_end',toolCallId:id,toolName:'read',args,result,isError:false,durationMs:1});};
    await primaryRead(1);report.beforeSignal=await status();assert.equal(report.beforeSignal.observation.completedPrimaryTools,1);assert.equal(report.beforeSignal.checks.runs,0);assert.equal(report.providerCalls.length,0);
    await control('observe local-signal');await until(status,v=>v.checks.detail.find(c=>c.checkId==='audit')?.lastOutcome!==null&&v.checks.runs===1,'source-triggered audit terminal result');
    const expected=foreign?0:reviewer?2:1;assert.equal(report.providerCalls.length,expected);report.afterAudit=await status();assert.equal(report.afterAudit.observation.completedPrimaryTools,1,'real owned reviewer tools and model requests never advance primary cadence');assert.equal(report.afterAudit.checks.detail.find(c=>c.checkId==='cadence').runs,0);
    assert.equal(report.afterAudit.accounting.ownedRequestCount,expected);assert.equal(report.afterAudit.accounting.settledCount,expected);assert.equal(report.afterAudit.accounting.unresolvedCount,0);
    if(!foreign){assert.ok(JSON.stringify(report.providerCalls[0].input).includes(RULE),'actual contributed resource bytes reached actual SDK input');}
    if(reviewer){assert.ok(JSON.stringify(report.providerCalls[1].input).includes('K08_ROLE_REVIEW_READ_CANARY'),'real reviewer read is delivered to later SDK request');}
    if(!denied&&!foreign){await until(status,()=>existsSync(destination),'actual permitted synthetic receiver');report.receiver={path:destination,value:await json(destination),...await identity(destination)};assert.equal(report.receiver.value.summary.coverage,'complete');}
    else assert.equal(existsSync(destination),false);
    const beforeRelabel=await status(),nextLabel=roleLabel==='parent-like'?'worker-like':roleLabel==='worker-like'?'subsession-like':'parent-like';manager.appendSessionInfo(nextLabel);await control('observe local-signal');for(let i=0;i<3;i++)await status();const afterRelabel=await status();
    report.relabel={from:roleLabel,to:manager.getSessionName(),sameSdkSessionId:manager.getSessionId()===report.sdkSession.id,before:beforeRelabel.runtime,after:afterRelabel.runtime,billingBefore:beforeRelabel.accounting,billingAfter:afterRelabel.accounting};assert.equal(report.relabel.sameSdkSessionId,true);assert.equal(afterRelabel.runtime.generation,beforeRelabel.runtime.generation);assert.equal(afterRelabel.accounting.ownedRequestCount,expected);assert.equal(report.providerCalls.length,expected);assert.equal(afterRelabel.checks.runs,1,'label change and duplicate source publication are not new work');
    await runner.emit({type:'input',text:'K08_ROLE_OBSERVER_ADVISORY_CANARY',source:'extension'});report.afterObserverInput=await status();
    const extInput=report.observations.filter(o=>o.kind==='core.operator-input').at(-1);report.observerInputOrigin=extInput?.origin??null;assert.equal(extInput.origin.kind,'external','observer-generated input is never operator authority');assert.equal(extInput.scope.authorizationRevision,report.observations.find(o=>o.kind==='fixture.signal').scope.authorizationRevision,'observer input does not advance operator authorization');
    await primaryRead(2);await until(status,v=>v.checks.detail.find(c=>c.checkId==='cadence')?.runs===1,'actual primary positive control advances the shared cadence');report.afterPrimary=await status();assert.equal(report.afterPrimary.observation.completedPrimaryTools,2);assert.equal(report.providerCalls.length,expected);assert.equal(report.afterPrimary.accounting.ownedRequestCount,expected);
    report.beforeShutdownControl=await control('status');
  }catch(e){failure=e;report.failure={name:e.name,message:e.message};}
  finally{
    if(runner){try{await runner.emit({type:'session_shutdown',reason:'quit'});stopped=true;}catch(e){failure??=e;report.shutdownError=e.message;}if(status)try{report.retired=await status();report.retiredControl=await control('status');}catch(e){failure??=e;}runner.invalidate('T07 local role fixture finished');}
    off?.();report.shutdownReturned=stopped;report.finalStateFiles=await files(process.env.PI_CODING_AGENT_DIR);report.remainingLocks=report.finalStateFiles.filter(p=>p.endsWith('.lock'));
    let physicalText='';for(const p of report.finalStateFiles.filter(p=>/\.jsonl(?:\.gz)?$/u.test(p))){const b=await readFile(p);physicalText+=(p.endsWith('.gz')?gunzipSync(b):b).toString('utf8')+'\n';}
    report.physical=physicalText.split('\n').filter(Boolean).map(JSON.parse);report.events=[...new Map([...captured.values(),...report.physical].map(e=>[e.eventId,e])).values()];
    try{if(!failure){
      const selected=report.events.filter(e=>e.event==='quality.check.started'&&e.fields.data.checkId==='audit');assert.equal(selected.length,1);const runId=selected[0].fields.correlation.runId;report.auditRunId=runId;report.canonical=report.events.find(e=>e.event==='quality.assessment.result'&&e.fields.correlation.runId===runId);assert.ok(report.canonical);
      report.admissions=report.events.filter(e=>e.event==='quality.action.admission'&&e.fields.correlation.runId===runId);report.receipts=report.events.filter(e=>e.event==='quality.action.receipt'&&e.fields.correlation.runId===runId);
      if(foreign){assert.equal(report.admissions.length,0);assert.ok(report.events.some(e=>e.event==='quality.component.note'&&e.fields.data.code==='fixture.audit-scope-refused'));}
      else{assert.equal(report.canonical.fields.data.validationState,'valid');assert.equal(report.canonical.fields.data.operational,'completed');assert.equal(report.canonical.fields.data.coverage,'complete');assert.equal(report.admissions.length,1);assert.equal(report.admissions[0].fields.data.outcome,denied?'rejected':'admitted');if(denied){assert.ok(report.admissions[0].fields.reasonCodes.includes('core.action-effects-unapproved'));assert.equal(report.receipts.length,0);}else{assert.equal(report.receipts.length,1);assert.equal(report.receipts[0].fields.data.state,'completed');assert.deepEqual(report.receiver.value.run.scope,report.canonical.fields.scope);assert.equal(report.receiver.value.run.runId,runId);}}
      const signal=report.observations.filter(o=>o.kind==='fixture.signal');assert.equal(signal.length,1,'duplicate delivery remains one accepted observation even after display relabel');assert.equal(signal[0].origin.kind,'external');assert.equal(signal[0].origin.ownerId,'fixture.observation');assert.equal(signal[0].scope.observedSessionId,report.sdkSession.id);
      assert.ok(report.observations.filter(o=>o.kind==='core.tool-completed').every(o=>o.origin.kind==='primary'));assert.equal(report.observations.filter(o=>o.kind==='core.tool-completed').length,2,'only actual primary reads enter primary host observations');
      report.reviewerOperations=report.events.filter(e=>e.event==='quality.component.note'&&e.fields.data.componentId==='core.pi-session'&&['core.reviewer-tool-acquired','core.reviewer-result-submitted'].includes(e.fields.data.code));if(reviewer){assert.equal(report.reviewerOperations.filter(e=>e.fields.data.code==='core.reviewer-tool-acquired').length,1);assert.equal(report.reviewerOperations.filter(e=>e.fields.data.code==='core.reviewer-result-submitted').length,1);assert.ok(report.reviewerOperations.every(e=>e.fields.correlation.runId===runId));}
      assert.equal(report.shutdownReturned,true);assert.deepEqual(report.remainingLocks,[]);assert.equal(report.pendingProviders,0);assert.ok(report.providerCalls.every(c=>c.returnedPhysically));assert.deepEqual(report.extensionErrors,[]);assert.deepEqual(report.effects,{sendMessage:0,sendUserMessage:0,appendEntry:0,abort:0});
      assert.equal(report.retiredControl.currentSource.disposals,1);assert.equal(report.retiredControl.currentSource.signalAborted,true);
      for(const marker of ['K08_ROLE_PRIMARY_READ_CANARY','K08_ROLE_REVIEW_READ_CANARY','K08_ROLE_OBSERVER_ADVISORY_CANARY',RULE])assert.equal(physicalText.includes(marker),false,'actual final Standard journal omits protected body');
      report.signature={providerRequests:report.providerCalls.length,ownedRequests:report.afterAudit.accounting.ownedRequestCount,auditRuns:1,primaryBefore:1,primaryAfter:2,cadenceBefore:0,cadenceAfter:1,action:foreign?'not-entered':denied?'rejected':'admitted',receiver:!!report.receiver,reviewerReads:reviewer?1:0};
    }}catch(e){failure??=e;report.failure??={name:e.name,message:e.message};}
    report.result=failure?'AUTHOR_FAIL':'AUTHOR_PASS';await save(join(root,'witness.json'),report);
  }
  if(failure)throw failure;
}
async function materialize(tarPath, destination) {
  const bytes = await readFile(tarPath), expected = tarInventory(bytes), tar = gunzipSync(bytes);
  for (let offset=0;offset+512<=tar.length;) {
    const header=tar.subarray(offset,offset+512);if(header.every(byte=>byte===0))break;
    const field=(a,b)=>header.subarray(a,b).toString('utf8').replace(/\0.*$/su,'');
    const prefix=field(345,500),name=(prefix?prefix+'/':'')+field(0,100),size=Number.parseInt(field(124,136).trim()||'0',8),kind=field(156,157);
    if(kind!=='5'){const target=resolve(destination,name.slice(8));assert.equal(inside(destination,target),true);await mkdir(dirname(target),{recursive:true});await writeFile(target,tar.subarray(offset+512,offset+512+size));}
    offset+=512+Math.ceil(size/512)*512;
  }
  const actual={};for(const[name,value]of Object.entries(expected)){actual[name]=await identity(join(destination,name));assert.deepEqual(actual[name],value);}
  return actual;
}

if(process.argv[2]==='--installed-child'){
  try{await roleChild(JSON.parse(process.argv[3]));}catch(error){console.error(error);process.exitCode=1;}
}else{
 test('K08-T07 installed local role neutrality: scope, grants and reviewer-origin cadence',{timeout:90000},async t=>{
  const evidence=process.env.QE_EVIDENCE_DIR;assert.ok(evidence&&isAbsolute(evidence));
  const root=await mkdtemp(join(evidence,'installed-role-neutrality-')),source=fileURLToPath(new URL('../',import.meta.url));
  const baseline=await packageInputs(source),env=await prepareEnvironment(root),mirror=join(root,'source-mirror'),engineMirror=join(mirror,'engine'),contributorMirror=join(mirror,'contributor'),artifacts=join(root,'artifacts');await mkdir(artifacts);
  for(const[name,expected]of Object.entries(baseline.payload)){assert.deepEqual(await identity(join(source,name)),expected);await mkdir(dirname(join(engineMirror,name)),{recursive:true});await copyFile(join(source,name),join(engineMirror,name));}
  const contributorSources={};for(const name of ['package.json','extension.mjs','resources/k08-context.md','resources/k08-prompt.md']){const p=join(source,'examples/independent-extension',name);await mkdir(dirname(join(contributorMirror,name)),{recursive:true});await copyFile(p,join(contributorMirror,name));contributorSources[name]=await identity(p);}
  const packages={};for(const[name,cwd]of [['engine',engineMirror],['contributor',contributorMirror],['yaml',baseline.existingYaml.path]]){const result=await runNative(join(root,'pack-'+name),npmCommand('pack','--json','--ignore-scripts','--offline','--pack-destination',artifacts),cwd,env);assert.equal(result.receipt.exit,0);const value=JSON.parse(result.stdout)[0],p=join(artifacts,value.filename);packages[name]={path:p,...await identity(p),inventory:tarInventory(await readFile(p))};}
  assert.deepEqual(packages.engine.inventory,baseline.payload);for(const name of Object.keys(contributorSources))assert.ok(packages.engine.inventory['examples/independent-extension/'+name],'B.09 actual engine tar carries public example '+name);const consumer=join(root,'consumer');await mkdir(consumer);await save(join(consumer,'package.json'),{name:'k08-installed-role-neutrality',private:true,type:'module'});
  const installed={};for(const[name,directory]of [['engine','pi-quality-engine'],['contributor','qe-independent-fixture'],['yaml','yaml']])installed[name]=await materialize(packages[name].path,join(consumer,'node_modules',directory));
  for(const[name,pin]of Object.entries(contributorSources))assert.deepEqual(await identity(join(consumer,'node_modules/pi-quality-engine/examples/independent-extension',name)),pin,'actual shipped example equals the independently executed contributor payload');
  const peer=join(consumer,'node_modules/@earendil-works/pi-coding-agent');await mkdir(dirname(peer),{recursive:true});await symlink(baseline.hostSdk.path,peer,'junction');const own=join(consumer,'driver-t07.mjs');await copyFile(fileURLToPath(import.meta.url),own);await rm(mirror,{recursive:true,force:true});assert.equal(existsSync(mirror),false);
  await save(join(root,'package-bindings.json'),{packages,installed,contributorSources,driver:{path:own,...await identity(own)},mirrorRemovedBeforeSdkImports:true,hostPeer:baseline.hostSdk,installation:'Regular tar payload extraction/readback in separate consumer. Existing pinned host SDK only; not a package-manager dependency-resolution claim.'});
  const labels=['parent-like','worker-like','subsession-like'],variants=['admitted','effect-denied','scope-denied','reviewer-origin'],executions=[],witnesses=[];
  for(const roleLabel of labels)for(const scenario of variants)await t.test(roleLabel+'/'+scenario,{timeout:20000},async()=>{
    const caseRoot=join(root,'cases',roleLabel,scenario),childEnv=await prepareEnvironment(caseRoot);const result=await runNative(join(caseRoot,'native'),[process.execPath,own,'--installed-child',JSON.stringify({root:caseRoot,consumer,scenario,roleLabel,mirror})],consumer,childEnv,15000);executions.push({roleLabel,scenario,receipt:result.receipt});assert.equal(result.receipt.exit,0,'actual role/source/grant/origin assertions');const w=await json(join(caseRoot,'witness.json'));assert.equal(w.result,'AUTHOR_PASS');witnesses.push({roleLabel,scenario,signature:w.signature,sdkSession:w.sdkSession,auditRunId:w.auditRunId});
  });
  // B.09 changes the package boundary, not production behavior. Requalify the
  // accepted connected26 on these same new tars/consumer; do not invent new
  // unique coverage or repeat unrelated K01-K07 suites.
  const prior=[['roles','k08-installed-roles-lifecycle.test.mjs',['observation-required','opposite-order','delayed-ready','validation','missing-dependency','unload-reregister','late-ready','generation-replacement','sink-failure','example-observation','example-observation-denied','observation-lifecycle','observation-late-start']],['trigger','k08-installed-contribution.test.mjs',['positive','context-omitted','contributor-absent']],['admission','k08-installed-admission.test.mjs',['admitted','request-outside-binding','request-run-outside-binding','effect-ungranted','selected-profile-unapproved','binding-safety','contributor-absent']],['sink-prompt','k08-installed-sink-prompt.test.mjs',['prompt-pair','sink-isolation','sink-unselected']]];
  for(const[group,name,scenarios]of prior){const driver=join(consumer,'prior-'+group+'.mjs');await copyFile(join(source,'test',name),driver);for(const scenario of scenarios)await t.test('requalify/'+group+'/'+scenario,{timeout:25000},async()=>{const caseRoot=join(root,'requalify',group,scenario),childEnv=await prepareEnvironment(caseRoot);const result=await runNative(join(caseRoot,'native'),[process.execPath,driver,'--installed-child',JSON.stringify({root:caseRoot,consumer,scenario,mirror})],consumer,childEnv,group==='sink-prompt'?20000:15000);executions.push({group,scenario,receipt:result.receipt});assert.equal(result.receipt.exit,0,'new package boundary preserves the exact accepted functional assertions');const w=await json(join(caseRoot,'witness.json'));assert.equal(w.result,'AUTHOR_PASS');assert.equal(w.shutdownReturned,true);assert.deepEqual(w.remainingLocks,[]);});}
  await save(join(root,'completion.json'),{logicalCases:38,roleNeutralityCases:12,packageRequalifications:26,executions,witnesses,notCrossProcessCertification:true,entireK08Accepted:false});
  assert.equal(witnesses.length,12);assert.equal(new Set(witnesses.map(w=>w.sdkSession.id)).size,12,'actual SDK sessions have their actual separate scope, not role-derived identities');
  for(const scenario of variants){const rows=witnesses.filter(w=>w.scenario===scenario);assert.equal(rows.length,3);for(const row of rows)assert.deepEqual(row.signature,rows[0].signature,'same supported local contract outcomes independent of display label');}
 });
}
