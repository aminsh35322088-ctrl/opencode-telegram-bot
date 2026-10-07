import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,chmod,rm,symlink} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {verifyWorkerRuntimeCanary} from "../src/infrastructure/worker-runtime-canary.js";

const slot={slot:1,nodeId:"canary",generation:1,unbound:true,phase:"deploying",serviceId:"service",volumeId:"volume"};
test("only the Root-owned unbound first slot runs sequential fixed profiles",async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),"runtime-canary-"));
 try{
  const filename=path.join(directory,"journal.json");
  await writeFile(filename,JSON.stringify({version:1,nodes:[slot,{...slot,slot:2,nodeId:"other"}]}),{mode:0o600});
  const calls:string[]=[];const logs:string[]=[];
  await verifyWorkerRuntimeCanary({journalPath:filename,selftest:async(id,generation,profile)=>{assert.equal(id,"canary");assert.equal(generation,1);calls.push(profile);},log:line=>{logs.push(line);}});
  assert.deepEqual(calls,["baseline","browser","network"]);assert.equal(logs.length,3);
 }finally{await rm(directory,{recursive:true,force:true});}
});
test("ambiguous, bound, incomplete, shared or linked journals admit no runtime probe",async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),"runtime-canary-"));
 try{
  const filename=path.join(directory,"journal.json");
  const invoke=(journalPath=filename)=>verifyWorkerRuntimeCanary({journalPath,selftest:async()=>{assert.fail("Denied journal reached Worker");},log:()=>{assert.fail("Denied journal reported success");}});
  for(const nodes of [[slot,slot],[{...slot,unbound:false}],[{...slot,volumeId:undefined}],[{...slot,phase:"retiring"}],[]]){
   await writeFile(filename,JSON.stringify({version:1,nodes}),{mode:0o600});await assert.rejects(invoke());
  }
  await writeFile(filename,JSON.stringify({version:1,nodes:[slot]}));await chmod(filename,0o644);await assert.rejects(invoke());
  await chmod(filename,0o600);const linked=path.join(directory,"linked.json");await symlink(filename,linked);await assert.rejects(invoke(linked));
 }finally{await rm(directory,{recursive:true,force:true});}
});
test("a failed canary stops later profiles and never emits positive proof",async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),"runtime-canary-"));
 try{
  const filename=path.join(directory,"journal.json");await writeFile(filename,JSON.stringify({version:1,nodes:[slot]}),{mode:0o600});
  const calls:string[]=[];const logs:string[]=[];
  await assert.rejects(verifyWorkerRuntimeCanary({journalPath:filename,selftest:async(_id,_generation,profile)=>{calls.push(profile);throw Error("Denied");},log:line=>{logs.push(line);}}));
  assert.deepEqual(calls,["baseline"]);assert.deepEqual(logs,[]);
 }finally{await rm(directory,{recursive:true,force:true});}
});
