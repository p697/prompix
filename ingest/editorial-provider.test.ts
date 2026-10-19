import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,writeFile,readFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {codexEditorialProvider,type EditorialAttemptEvidence} from './editorial-provider.ts';
import type {EditorialInput} from './editorial-runner.ts';
const item:EditorialInput={id:'synthetic',fingerprint:'a'.repeat(64),kind:'text',contentType:'prompt',expectedOutputKind:'text',title:'Synthetic',summary:'Synthetic fixture',prompt:'Write a three-step plan for a quiet weekend.',model:'General',source:{name:'Synthetic',license:'Original test fixture',method:'Synthetic fixture',url:null},hasImage:false,hasVideo:false,hasDemo:false,requiredPreviewLabel:'提示词主题'};
for(const behavior of ['exit','partial','malformed','success','oversized']) test(`editorial attempt evidence survives ${behavior}`,async t=>{
 const root=await mkdtemp(join(tmpdir(),'prompix-editorial-evidence-test-'));t.after(()=>rm(root,{recursive:true,force:true}));const exe=join(root,'fake.mjs'),capture=join(root,'capture.json');
 await writeFile(exe,`#!/usr/bin/env node
import {writeFile} from 'node:fs/promises';
const args=process.argv.slice(2),arg=k=>args[args.indexOf(k)+1];for await(const chunk of process.stdin){}
await writeFile(${JSON.stringify(capture)},JSON.stringify({directory:arg('--cd')}));
process.stdout.write(JSON.stringify({type:'thread.started'})+'\\n');
const behavior=${JSON.stringify(behavior)};
if(behavior==='oversized')process.stdout.write('x'.repeat(2100000));
if(behavior!=='exit'&&behavior!=='oversized')await writeFile(arg('--output-last-message'),behavior==='partial'?'partial output':behavior==='malformed'?'{broken':JSON.stringify({decisions:[{id:'synthetic',fingerprint:'a'.repeat(64),outputKind:'text',decision:'defer',reason:'Synthetic incomplete instructions',metadata:null}]}));
if(behavior!=='success')process.stdout.write(JSON.stringify({type:'turn.failed',error:{message:'Synthetic provider failure'}})+'\\n');
process.exitCode=behavior==='exit'||behavior==='partial'?1:0;
`,{mode:0o755});
 const records:EditorialAttemptEvidence[]=[];let responses=0;
 const call=()=>codexEditorialProvider(exe,async()=>{responses++;},async evidence=>{records.push(evidence);})([item]);
 if(behavior==='success')assert.ok(Array.isArray((await call()).decisions));else await assert.rejects(call());
 assert.equal(records.length,1);const evidence=records[0];assert.match(evidence.events,/thread.started/);assert.ok(Buffer.byteLength(evidence.events)<=2000000);
 if(behavior==='oversized')assert.equal(evidence.eventsTruncated,true);
 if(behavior==='exit'){assert.equal(evidence.exitCode,1);assert.equal(evidence.outputText,null);assert.equal(responses,0);}
 if(behavior==='partial'){assert.equal(evidence.outputText,'partial output');assert.equal(evidence.exitCode,1);assert.equal(responses,0);}
 if(behavior==='malformed')assert.equal(evidence.outputText,'{broken');
 const {directory}=JSON.parse(await readFile(capture,'utf8'));await assert.rejects(access(directory));
});
test('failed evidence persistence keeps temporary artifacts and fails closed',async t=>{
 const root=await mkdtemp(join(tmpdir(),'prompix-editorial-persist-test-'));t.after(()=>rm(root,{recursive:true,force:true}));const exe=join(root,'fake.mjs'),capture=join(root,'directory');
 await writeFile(exe,`#!/usr/bin/env node
import {writeFile} from 'node:fs/promises';for await(const chunk of process.stdin){}const a=process.argv;await writeFile(${JSON.stringify(capture)},a[a.indexOf('--cd')+1]);process.exitCode=1;
`,{mode:0o755});
 await assert.rejects(codexEditorialProvider(exe,undefined,async()=>{throw Error('Evidence storage unavailable');})([item]),/Evidence storage unavailable/);
 const dir=await readFile(capture,'utf8');t.after(()=>rm(dir,{recursive:true,force:true}));await access(dir);
});
