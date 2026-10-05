import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeProtocol } from "../src/control-plane/node-protocol.js";

test("signed requests fence identity, timestamp and durable replay", async () => {
  const dir = await mkdtemp(join(tmpdir(), "node-protocol-"));
  const identity = {nodeId:"node-1", generation:2, chatId:10, threadId:3};
  const secret = "synthetic-node-key".repeat(4);
  const request = {...identity,version:1 as const,sessionId:"session-1",operation:"snapshot.get",payload:{},timestamp:100_000,nonce:"0123456789abcdef0123456789abcdef"};
  try {
    const protocol = new NodeProtocol(join(dir,"replay.json"),()=>100_000);
    const signed = protocol.sign(request,secret);
    assert.equal((await protocol.verify(signed.body,signed.signature,identity,secret)).sessionId,"session-1");
    await assert.rejects(protocol.verify(signed.body,signed.signature,identity,secret),/replay/);
    const restart = new NodeProtocol(join(dir,"replay.json"),()=>100_000);
    await assert.rejects(restart.verify(signed.body,signed.signature,identity,secret),/replay/);
    await assert.rejects(restart.verify(signed.body,signed.signature,{...identity,generation:3},secret),/identity/);
    await assert.rejects(restart.verify(signed.body,"0".repeat(64),identity,secret),/signature/);
    const expired = new NodeProtocol(join(dir,"other.json"),()=>200_000);
    await assert.rejects(expired.verify(signed.body,signed.signature,identity,secret),/timestamp/);
  } finally {await rm(dir,{recursive:true,force:true});}
});
