import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function source(path:string):Promise<string>{return await readFile(new URL(`../${path}`,import.meta.url),"utf8").catch(()=>"");}

test("Telegram root and New Chat are gated by Railway onboarding before Worker allocation",async()=>{
 const start=await source("src/bot/commands/start-command.ts");
 const create=await source("src/bot/commands/new-command.ts");
 const onboarding=await source("src/bot/commands/railway-onboarding-command.ts");
 assert.match(start,/ensureRailwayInfrastructureConfigured/);
 assert.match(create,/ensureRailwayInfrastructureConfigured/);
 assert.match(onboarding,/requestInfrastructureSetup\("status"/);
 assert.match(onboarding,/requestInfrastructureSetup\("credential\.begin"/);
 assert.match(onboarding,/requestInfrastructureSetup\("workspace\.select"/);
});

test("Railway credential messages are consumed and deleted before normal prompt routing",async()=>{
 const commandRouter=await source("src/bot/routers/command-router.ts");
 const onboarding=await source("src/bot/commands/railway-onboarding-command.ts");
 assert.match(commandRouter,/handleRailwayOnboardingMessage/);
 assert.ok(commandRouter.indexOf("if (await handleRailwayOnboardingMessage")<commandRouter.indexOf("if (await handleProviderWizardMessage"));
 assert.match(onboarding,/deleteInputMessage/);
 assert.match(onboarding,/railway:workspace:/);
 assert.match(onboarding,/setTopicNodeCreationEnabled\(true\)/);
});

test("Railway workspace buttons are handled by the central callback router",async()=>{
 const callbacks=await source("src/bot/callbacks/callback-router.ts");
 assert.match(callbacks,/handleRailwayOnboardingCallback/);
 assert.match(callbacks,/\["railway"/);
});
