import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolveControlRuntimeConfig,configureApplicationEnvironment} from '../src/infrastructure/control-runtime-config.js';

test('normal Railway deployment derives infrastructure mode without Worker policy env flags',()=>{
 const environment={RAILWAY_PROJECT_ID:'portable-project',RAILWAY_ENVIRONMENT_ID:'portable-environment',RAILWAY_SERVICE_ID:'portable-service',RAILWAY_REPLICA_REGION:'sfo'};
 assert.deepEqual(resolveControlRuntimeConfig(environment,true,false),{gatewayEnabled:true,projectId:'portable-project',environmentId:'portable-environment',serviceId:'portable-service',region:'sfo'});
});

test('obsolete flags and Worker policy env overrides are stripped from the application environment',()=>{
 const environment:NodeJS.ProcessEnv={RAILWAY_PROJECT_ID:'p',RAILWAY_ENVIRONMENT_ID:'e',RAILWAY_SERVICE_ID:'s',CONTROL_INFRASTRUCTURE_ENABLED:'0',CONTROL_PROVISION_WORKERS_ENABLED:'0',CONTROL_WORKSPACE_ID:'foreign',CONTROL_PUBLIC_URL:'https://foreign.invalid',CONTROL_WORKER_REGION:'foreign',CONTROL_WORKER_A_PROJECT_ID:'foreign',CONTROL_CLUSTER_BOOTSTRAP_ENABLED:'0',TOPIC_NODE_CREATION_ENABLED:'0',WORKER_WARM_CAPACITY:'99',WORKER_POOL_POLICY:'[]',TELEGRAM_ALLOWED_USER_ID:'42'};
 const config=resolveControlRuntimeConfig(environment,true,false);assert.equal(config.gatewayEnabled,true);assert.equal(config.projectId,'p');assert.equal(config.region,'europe-west4-drams3a');
 configureApplicationEnvironment(environment);
 for(const name of ['CONTROL_WORKSPACE_ID','CONTROL_INFRASTRUCTURE_ENABLED','CONTROL_PROVISION_WORKERS_ENABLED','CONTROL_CLUSTER_BOOTSTRAP_ENABLED','TOPIC_NODE_CREATION_ENABLED','WORKER_WARM_CAPACITY','WORKER_POOL_POLICY','TELEGRAM_ALLOWED_USER_ID'])assert.equal(name in environment,false,name);
 assert.equal(environment.RAILWAY_PROJECT_ID,'p');assert.equal(environment.RAILWAY_SERVICE_ID,'s');
});

test('Worker bootstrap policy is no longer projected into process environment',()=>{
 const environment:NodeJS.ProcessEnv={RAILWAY_SERVICE_ID:'s',CONTROL_CLUSTER_BOOTSTRAP_ENABLED:'0',WORKER_WARM_CAPACITY:'4'};
 const config=resolveControlRuntimeConfig(environment,true,false);assert.equal(config.gatewayEnabled,true);
 configureApplicationEnvironment(environment);assert.equal(environment.CONTROL_CLUSTER_BOOTSTRAP_ENABLED,undefined);assert.equal(environment.WORKER_WARM_CAPACITY,undefined);
});

test('existing Nodes keep gateway during credential outage without local Worker policy copies',()=>{
 const config=resolveControlRuntimeConfig({},false,true);assert.equal(config.gatewayEnabled,true);
 assert.equal(resolveControlRuntimeConfig({},false,false).gatewayEnabled,false);
});
