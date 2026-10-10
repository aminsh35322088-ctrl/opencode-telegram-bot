import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

test("the default integration fetch works inside workerd with the native receiver", async () => {
  const built=await build({ stdin:{contents:`
    import {CloudIntegrationConnections} from './src/cloudflare/integration-connections.ts';
    export default {async fetch(){
      const sql={exec(){return []}};
      try {const result=await new CloudIntegrationConnections(sql,btoa('k'.repeat(32)))
        .connect('github','synthetic-fixture-only');
        return Response.json({username:result.username});}
      catch(error){return Response.json({error:error.message},{status:500});}
    }};
  `,resolveDir:process.cwd()},bundle:true,format:"esm",platform:"browser",write:false});
  let calls=0;
  const runtime=new Miniflare(convertV4MiniflareOptions({modules:true,compatibilityDate:"2026-10-07",
    script:built.outputFiles[0]!.text,outboundService:async(request:Request)=>{
      calls++;
      assert.equal(request.url,"https://api.github.com/user");
      return Response.json({login:"safe-fixture"});
    }}));
  try {
    const response=await runtime.dispatchFetch("http://worker.local/");
    assert.equal(response.status,200,await response.clone().text());
    assert.deepEqual(await response.json(),{username:"safe-fixture"});
    assert.equal(calls,1);
  } finally {await runtime.dispose();}
});
