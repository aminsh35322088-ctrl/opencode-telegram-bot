import assert from "node:assert/strict";
import { test } from "node:test";
import { createInfrastructureClient, InfrastructureRequestError } from "../src/infrastructure/railway-client.js";

test("infrastructure credential is removed before loading runtime or startup shell", async () => {
  const environment = { RAILWAY_API_TOKEN: "synthetic-account", RAILWAY_TOKEN: "synthetic-project", KEEP: "yes" };
  const client = createInfrastructureClient(environment);
  assert.deepEqual(environment, { KEEP: "yes" });
  assert.deepEqual(Object.keys(client).sort(), ["configured", "dispose", "request"]);
  client.dispose();
  await assert.rejects(client.request("query { me { id } }"), /unavailable/);
});

test("GraphQL errors fail even when HTTP status is 200 and are not reflected", async () => {
  const client = createInfrastructureClient({ RAILWAY_API_TOKEN: "synthetic-account" }, async () =>
    new Response(JSON.stringify({ errors: [{ message: "sensitive server detail" }] }), { status: 200 }),
  );
  await assert.rejects(client.request("query { me { id } }"), (error: unknown) =>
    error instanceof Error && error.message === "Railway infrastructure request failed",
  );
  client.dispose();
});

test("infrastructure rate limiting honors Retry-After without retrying ambiguous mutations",async()=>{
 let calls=0;
 const client=createInfrastructureClient({RAILWAY_API_TOKEN:"synthetic-account"},async()=>{calls++;return new Response("{}",{status:429,headers:{"retry-after":"120"}});});
 await assert.rejects(client.request("mutation { serviceCreate }"),/request failed/);
 await assert.rejects(client.request("mutation { serviceCreate }"),/retry deferred/);
 assert.equal(calls,1);client.dispose();
});

test("safe infrastructure failure categories never reflect server details", async()=>{
 for(const [message,category] of [["Cannot query field something-sensitive", "schema"],["Free plan resource provision limit exceeded. sensitive", "resource_limit"],["sensitive server detail", "rejected"]] as const){
  const client=createInfrastructureClient({RAILWAY_API_TOKEN:"synthetic-account"},async()=>new Response(JSON.stringify({errors:[{message}]}),{status:200}));
  await assert.rejects(client.request("query Example { field }"),error=>error instanceof InfrastructureRequestError && error.category===category && error.status===200 && error.message==="Railway infrastructure request failed" && !JSON.stringify(error).includes("sensitive"));
  client.dispose();
 }
});
