// DELTA334-CAP-F1 + DELTA337-REASONING-F1: ordinary installed profile options and unchanged public SDK serializer.
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

import http from 'node:http'; import https from 'node:https'; import net from 'node:net'; import tls from 'node:tls'; import { syncBuiltinESMExports } from 'node:module';
async function capChild(options){
 const {route,root:out}=options,profileCap=options.profileCap??1024,evaluatorCap=options.evaluatorCap??1024,admittedCap=Math.min(profileCap,evaluatorCap),wireCeiling=Math.min(admittedCap,options.sampling?.max_completion_tokens??admittedCap);
const save=(p,v)=>writeFile(p,JSON.stringify(v,null,2)+'\n',{flag:'wx'});
const report={route,evaluator:'core.'+route,configuredOutputTokens:profileCap,evaluatorOutputTokens:evaluatorCap,frames:[],wire:[],effects:0,uncontrolledNetworkAttempts:0,changesToCapOptionsOrPayload:false};
const deny=()=>{report.uncontrolledNetworkAttempts++;throw new Error('335-network-denied');};globalThis.fetch=deny;http.request=deny;http.get=deny;https.request=deny;https.get=deny;net.connect=deny;net.createConnection=deny;net.Socket.prototype.connect=deny;tls.connect=deny;syncBuiltinESMExports();
let runner=null,shutdown=false,status=null,failed=null;
const started=performance.now();
const ownedFiles=async root=>{const all=[];for(const item of await readdir(root,{withFileTypes:true}).catch(()=>[])){if(item.isSymbolicLink()||/auth|settings|models|^\.env/iu.test(item.name))continue;const p=join(root,item.name);if(item.isDirectory())all.push(...await ownedFiles(p));else if(item.isFile())all.push(p);}return all;};
try{
 const sdk=await import('@earendil-works/pi-coding-agent');const {InMemoryCredentialStore,InMemoryModelsStore}=await import('@earendil-works/pi-ai');const {getBuiltinModel}=await import('@earendil-works/pi-ai/providers/all');const {streamSimple}=await import('@earendil-works/pi-ai/api/openai-completions');
 const model=getBuiltinModel('openrouter','openai/gpt-4.1-mini');assert.ok(model);report.catalog=model;
 const project=join(out,'project'),agentDir=process.env.PI_CODING_AGENT_DIR,engine=fileURLToPath(new URL('./node_modules/pi-quality-engine',import.meta.url));await mkdir(project);await mkdir(join(agentDir,'quality'),{recursive:true});
 await writeFile(join(project,'task.md'),'Inspect this neutral synthetic material. Transport mechanism only; no live judgment.\n');await writeFile(join(project,'requirements.md'),'R1: record only what the supplied synthetic material establishes.\n');
 const config={schemaVersion:1,enabled:true,mode:'observe',sources:{task:{uris:['project:task.md'],role:'evidence',required:true},requirements:{uris:['project:requirements.md'],role:'requirement',required:true}},modelProfiles:{bounded:{provider:'openrouter',model:'openai/gpt-4.1-mini',reasoning:options.reasoning??'off',requestTimeoutMs:5000,maxAttempts:1,retryDelayMs:0,maxOutputTokens:profileCap,price:'host-catalog',requiredInputs:['text']}},permissions:{modelProfiles:['bounded']},prompts:{p:{use:'core.prompt-files',options:{instructions:['builtin:engineering-v1.md']}}},contexts:{c:{providers:[{id:'files',use:'core.files',options:{sourceIds:['task','requirements']}}],maxEstimatedTokens:4000}},evaluators:{e:{use:'core.'+route,modelProfile:'bounded',options:route==='pi-session'?{tools:['read'],readSources:[],allowProjectReads:true,maxModelRequests:1,maxToolCalls:1,maxAdditionalReadBytes:1024,timeoutMs:5000,maxOutputTokens:evaluatorCap,repairAttempts:0}:{maxOutputTokens:evaluatorCap,repairAttempts:0}}},policies:{p:{use:'core.record-only'}},checks:{check:{triggers:[{id:'one',use:'core.every-tools',options:{count:1}}],context:'c',prompt:'p',evaluator:'e',policy:'p',cooldownMs:0,maxRunsPerEpisode:1,criteria:['correctness.requirements'],workStates:['work-expected']}},runtime:{maxConcurrentEvaluations:1,maxConcurrentReviewers:1,maxRequestsPerSession:1,maxOwnedTokensPerSession:16384,unknownCost:'deny',maxOwnedCost:{currency:'USD',amount:'0.10'},defaultRunTimeoutMs:10000,maxRunTimeoutMs:10000,maxEscalationsPerEpisode:0}};
 report.configuration=config;await save(join(agentDir,'quality/config.json'),config);
 const loader=new sdk.DefaultResourceLoader({cwd:project,agentDir,settingsManager:sdk.SettingsManager.inMemory(),noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,systemPrompt:'',appendSystemPrompt:[],additionalExtensionPaths:[join(engine,'dist/index.js')]});await loader.reload();assert.deepEqual(loader.getExtensions().errors,[]);
 const models=await sdk.ModelRuntime.create({credentials:new InMemoryCredentialStore(),modelsStore:new InMemoryModelsStore(),modelsPath:null,refreshOnCreate:false,allowModelNetwork:false});
 const result={operational:'completed',coverage:{state:'complete',scopeDescription:'Synthetic output-cap protocol response only, no live engineering claim.',issues:[]},conclusion:'no-supported-finding',findings:[],scores:[],additionalEvidence:[],dependencies:[],usageAttemptIds:[]};
 const controlledFetch=async(url,init)=>{
  const body=JSON.parse(init.body);report.wire.push({url:String(url),method:init.method,body,bodyUtf8Bytes:Buffer.byteLength(init.body),actualCap:body.max_completion_tokens??body.max_tokens,requestHeadersRetained:false});assert.equal(body.model,'openai/gpt-4.1-mini');assert.equal(report.wire.length,1);if(options.expectedReasoning!==undefined){assert.equal(body.reasoning_effort,undefined,'the registered OpenRouter format uses nested reasoning');assert.equal(body.reasoning?.effort,options.expectedReasoning,'selected profile reasoning reaches the actual serializer, not an ambient SDK default');}for(const key of ['temperature','top_p'])if(options.sampling?.[key]!==undefined)assert.equal(body[key],options.sampling[key],'ordinary sampling option preserved');
  if(status!==null)report.statusAtWire=await status();
  const base={id:'synthetic-335',object:'chat.completion.chunk',created:1,model:model.id};
  const delta=route==='pi-session'?{role:'assistant',tool_calls:[{index:0,id:'submit-335',type:'function',function:{name:'submit_result',arguments:JSON.stringify(result)}}]}:{role:'assistant',content:JSON.stringify(result)};
  const chunks=[{...base,choices:[{index:0,delta,finish_reason:null}]},{...base,choices:[{index:0,delta:{},finish_reason:route==='pi-session'?'tool_calls':'stop'}]},{...base,choices:[],usage:{prompt_tokens:120,completion_tokens:30,total_tokens:150}}];
  return new Response(chunks.map(x=>'data: '+JSON.stringify(x)+'\n\n').join('')+'data: [DONE]\n\n',{status:200,headers:{'content-type':'text/event-stream'}});
 };
 models.registerProvider('openrouter',{name:'335 observation-only serializer transport',api:'openai-completions',apiKey:'synthetic-not-a-credential',baseUrl:model.baseUrl,models:[{...model,...(options.reasoningFixture?{reasoning:true,thinkingLevelMap:{off:'none',minimal:null,low:'low',medium:null,high:'high',xhigh:null,max:null},compat:{...model.compat,supportsReasoningEffort:true}}:{}),...(options.sampling?{samplingParams:options.sampling}:{})}],streamSimple(selected,context,options={}){
  report.frames.push({model:{provider:selected.provider,id:selected.id,api:selected.api,maxTokens:selected.maxTokens},incomingMaxTokens:options.maxTokens??null,incomingReasoning:options.reasoning??null,inputUtf8Bytes:Buffer.byteLength(JSON.stringify(context)),optionsKeys:Object.keys(options),context});
  // Deliberately NO maxTokens/onPayload/sampling override. The installed
  // product's own options go unchanged into the pinned public serializer.
  return streamSimple(selected,context,{...options,apiKey:'synthetic-not-a-credential',env:{},fetch:controlledFetch,maxRetries:0,timeoutMs:5000});
 }});
 const loaded=loader.getExtensions(),messages=[],noop=()=>{},registry=new sdk.ModelRegistry(models);runner=new sdk.ExtensionRunner(loaded.extensions,loaded.runtime,project,sdk.SessionManager.inMemory(project),registry);
 runner.onError(e=>{report.extensionErrors??=[];report.extensionErrors.push({event:e.event});});
 runner.bindCore({sendMessage:()=>report.effects++,sendUserMessage:()=>report.effects++,appendEntry:()=>report.effects++,setSessionName:noop,getSessionName:()=>undefined,setLabel:noop,getActiveTools:()=>[],getAllTools:()=>[],getSettings:()=>({}),setActiveTools:noop,refreshTools:noop,getCommands:()=>[],setModel:noop,getThinkingLevel:()=> 'off',setThinkingLevel:noop},{getModel:()=>undefined,getScopedModels:()=>[],isIdle:()=>true,isProjectTrusted:()=>true,getSignal:()=>undefined,abort:()=>report.effects++,hasPendingMessages:()=>false,shutdown:noop,getContextUsage:()=>undefined,compact:noop,getSystemPrompt:()=>''});runner.setUIContext({...runner.getUIContext(),notify:value=>messages.push(value)},'rpc');const command=runner.getCommand('quality');status=async()=>{await command.handler('status',runner.createCommandContext());return JSON.parse(messages.at(-1));};
 await runner.emit({type:'session_start',reason:'startup'});report.initial=await status();assert.equal(report.initial.configuration.rejection,null);
 await runner.emitInput('Assess the neutral provided synthetic evidence.',undefined,'interactive');await runner.emit({type:'tool_execution_start',toolCallId:'primary-done',toolName:'fixture.progress',args:{}});await runner.emit({type:'tool_execution_end',toolCallId:'primary-done',toolName:'fixture.progress',result:{content:[]},isError:false,durationMs:1});
 const end=performance.now()+12000;do{report.settled=await status();if(report.settled.diagnostics.recentEvents.some(x=>x.event==='quality.check.settled'))break;await new Promise(r=>setTimeout(r,10));}while(performance.now()<end);
 await runner.emit({type:'session_shutdown',reason:'quit'});shutdown=true;report.retired=await status();runner.invalidate('335 isolated cap discriminator complete');
 report.catalogSamplingAfter=registry.findOfType('chat','openrouter','openai/gpt-4.1-mini').samplingParams??null;if(options.sampling)assert.deepEqual(report.catalogSamplingAfter,options.sampling,'request-local bounding never mutates the SDK model catalog');
 assert.equal(report.frames.length,1);assert.equal(report.wire.length,1);
}catch(e){failed=e;report.failure={name:e.name,message:e.message};}
finally{
 if(runner&&!shutdown){try{await runner.emit({type:'session_shutdown',reason:'quit'});shutdown=true;runner.invalidate('335 failure cleanup');}catch(e){report.cleanupError=e.message;failed??=e;}}
 const files=await ownedFiles(process.env.PI_CODING_AGENT_DIR);report.journalFiles=files.filter(p=>/\.jsonl(?:\.gz)?$/u.test(p));report.remainingLocks=files.filter(p=>p.endsWith('.lock'));const events=[];
 for(const p of report.journalFiles){const b=await readFile(p),text=(p.endsWith('.gz')?gunzipSync(b):b).toString('utf8');events.push(...text.split('\n').filter(Boolean).map(x=>JSON.parse(x)));}
 report.physicalDispatched=events.filter(x=>x.event==='quality.model.dispatched');report.physicalCanonical=events.filter(x=>x.event==='quality.assessment.result');report.physicalSettled=events.filter(x=>x.event==='quality.check.settled');report.shutdownReturned=shutdown;report.elapsedMs=performance.now()-started;
 try{assert.equal(report.uncontrolledNetworkAttempts,0);assert.equal(report.effects,0);assert.equal(shutdown,true);assert.deepEqual(report.remainingLocks,[]);assert.equal(report.physicalDispatched.length,1);assert.equal(report.physicalDispatched[0].fields.data.maxOutputTokens,admittedCap);assert.equal(report.physicalDispatched[0].fields.data.reasoningSetting,(options.reasoning??'off')==='off'?null:options.reasoning);assert.equal(report.physicalCanonical.length,1);assert.equal(report.physicalCanonical[0].fields.data.validationState,'valid');assert.equal(report.physicalCanonical[0].fields.data.operational,'completed','a valid failure envelope is not successful assessment');assert.equal(report.physicalCanonical[0].fields.data.coverage,'complete');assert.equal(report.physicalSettled.length,1);}catch(e){failed??=e;report.failure??={name:e.name,message:e.message};}
 const cap=report.wire[0]?.actualCap;report.productCapSatisfied=Number.isSafeInteger(cap)&&cap>0&&cap<=wireCeiling&&report.wire.every(w=>['max_tokens','max_completion_tokens'].filter(k=>w.body[k]!==undefined).every(k=>Number.isSafeInteger(w.body[k])&&w.body[k]>0&&w.body[k]<=wireCeiling));report.result=failed?'HARNESS_OR_PRECONDITION_FAILURE':report.productCapSatisfied?'ORDINARY_CAP_PASS':'PRODUCT_RED_OUTPUT_CAP';report.actualExternalRequests=0;await save(join(out,'witness.json'),report);
}
console.log(JSON.stringify({route,result:report.result,incomingMaxTokens:report.frames[0]?.incomingMaxTokens,wireCap:report.wire[0]?.actualCap,wireBytes:report.wire[0]?.bodyUtf8Bytes,elapsedMs:report.elapsedMs}));
process.exitCode=failed?2:report.productCapSatisfied?0:1;

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
  try{await capChild(JSON.parse(process.argv[3]));}catch(error){console.error(error);process.exitCode=1;}
}else{
 test('337 ordinary output-cap serialization and admitted-min regression',{timeout:90000},async t=>{
  const evidence=process.env.QE_EVIDENCE_DIR;assert.ok(evidence&&isAbsolute(evidence));
  const root=await mkdtemp(join(evidence,'installed-output-cap-')),source=fileURLToPath(new URL('../',import.meta.url));
  const baseline=await packageInputs(source),env=await prepareEnvironment(root),mirror=join(root,'source-mirror'),engineMirror=join(mirror,'engine'),contributorMirror=join(mirror,'contributor'),artifacts=join(root,'artifacts');await mkdir(artifacts);
  for(const[name,expected]of Object.entries(baseline.payload)){assert.deepEqual(await identity(join(source,name)),expected);await mkdir(dirname(join(engineMirror,name)),{recursive:true});await copyFile(join(source,name),join(engineMirror,name));}
  const contributorSources={};for(const name of ['package.json','extension.mjs','resources/k08-context.md','resources/k08-prompt.md']){const p=join(source,'examples/independent-extension',name);await mkdir(dirname(join(contributorMirror,name)),{recursive:true});await copyFile(p,join(contributorMirror,name));contributorSources[name]=await identity(p);}
  const packages={};for(const[name,cwd]of [['engine',engineMirror],['contributor',contributorMirror],['yaml',baseline.existingYaml.path]]){const result=await runNative(join(root,'pack-'+name),npmCommand('pack','--json','--ignore-scripts','--offline','--pack-destination',artifacts),cwd,env);assert.equal(result.receipt.exit,0);const value=JSON.parse(result.stdout)[0],p=join(artifacts,value.filename);packages[name]={path:p,...await identity(p),inventory:tarInventory(await readFile(p))};}
  assert.deepEqual(packages.engine.inventory,baseline.payload);for(const name of Object.keys(contributorSources))assert.ok(packages.engine.inventory['examples/independent-extension/'+name],'B.09 actual engine tar carries public example '+name);const consumer=join(root,'consumer');await mkdir(consumer);await save(join(consumer,'package.json'),{name:'k08-installed-output-cap',private:true,type:'module'});
  const installed={};for(const[name,directory]of [['engine','pi-quality-engine'],['contributor','qe-independent-fixture'],['yaml','yaml']])installed[name]=await materialize(packages[name].path,join(consumer,'node_modules',directory));
  for(const[name,pin]of Object.entries(contributorSources))assert.deepEqual(await identity(join(consumer,'node_modules/pi-quality-engine/examples/independent-extension',name)),pin,'actual shipped example equals the independently executed contributor payload');
  const peer=join(consumer,'node_modules/@earendil-works/pi-coding-agent');await mkdir(dirname(peer),{recursive:true});await symlink(baseline.hostSdk.path,peer,'junction');const ai=join(consumer,'node_modules/@earendil-works/pi-ai');const aiSource=await realpath(join(source,'node_modules/@earendil-works/pi-ai')),aiManifest=await json(join(aiSource,'package.json'));assert.equal(aiManifest.version,'1.1.0','explicit public pi-ai peer, not a presumed nested dependency');await symlink(aiSource,ai,'junction');const own=join(consumer,'driver-t07.mjs');await copyFile(fileURLToPath(import.meta.url),own);await rm(mirror,{recursive:true,force:true});assert.equal(existsSync(mirror),false);
  await save(join(root,'package-bindings.json'),{packages,installed,contributorSources,driver:{path:own,...await identity(own)},mirrorRemovedBeforeSdkImports:true,hostPeer:baseline.hostSdk,aiPeer:{path:aiSource,version:aiManifest.version,metadata:await identity(join(aiSource,'package.json'))},installation:'Regular tar payload extraction/readback in separate consumer. Existing pinned host SDK only; not a package-manager dependency-resolution claim.'});
  const cases=[{name:'chat-1024',route:'chat'},{name:'reviewer-1024',route:'pi-session'},{name:'reviewer-profile-min256',route:'pi-session',profileCap:256},{name:'reviewer-evaluator-min128',route:'pi-session',evaluatorCap:128},{name:'chat-sampling',route:'chat',sampling:{temperature:0.25,top_p:0.8}},{name:'reviewer-sampling',route:'pi-session',sampling:{temperature:0.25,top_p:0.8}},{name:'chat-sampling-lower',route:'chat',sampling:{max_completion_tokens:64}},{name:'reviewer-sampling-lower',route:'pi-session',sampling:{max_completion_tokens:64}},{name:'chat-sampling-upper',route:'chat',sampling:{max_completion_tokens:8192}},{name:'reviewer-sampling-upper',route:'pi-session',sampling:{max_completion_tokens:8192}},{name:'reviewer-reasoning-off',route:'pi-session',reasoningFixture:true,reasoning:'off',expectedReasoning:'none'},{name:'reviewer-reasoning-low',route:'pi-session',reasoningFixture:true,reasoning:'low',expectedReasoning:'low'},{name:'reviewer-reasoning-high',route:'pi-session',reasoningFixture:true,reasoning:'high',expectedReasoning:'high'}],executions=[];
  for(const item of cases)await t.test(item.name,{timeout:20000},async()=>{const caseRoot=join(root,'cases',item.name),childEnv=await prepareEnvironment(caseRoot);const result=await runNative(join(caseRoot,'native'),[process.execPath,own,'--installed-child',JSON.stringify({root:caseRoot,consumer,mirror,...item})],consumer,childEnv,15000);executions.push({name:item.name,receipt:result.receipt});assert.equal(result.receipt.exit,0,'ordinary final serializer bound, not wrapper clamp');const w=await json(join(caseRoot,'witness.json'));assert.equal(w.result,'ORDINARY_CAP_PASS');assert.equal(w.changesToCapOptionsOrPayload,false);assert.equal(w.actualExternalRequests,0);assert.equal(w.shutdownReturned,true);assert.deepEqual(w.remainingLocks,[]);});
  await save(join(root,'completion.json'),{logicalCases:cases.length,executions,marker:'DELTA334-CAP-F1',liveRequests:0,entireK08Accepted:false});
 });
}
