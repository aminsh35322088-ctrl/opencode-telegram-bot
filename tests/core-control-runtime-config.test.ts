import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolveControlRuntimeConfig,configureApplicationEnvironment} from '../src/infrastructure/control-runtime-config.js';
test('normal Railway deployment derives infrastructure mode with no internal flags or IDs',()=>{
 const environment={RAILWAY_PROJECT_ID:'portable-project',RAILWAY_ENVIRONMENT_ID:'portable-environment',RAILWAY_SERVICE_ID:'portable-service',RAILWAY_REPLICA_REGION:'sfo'};
 assert.deepEqual(resolveControlRuntimeConfig(environment,true,false),{gatewayEnabled:true,bootstrapEnabled:true,projectId:'portable-project',environmentId:'portable-environment',serviceId:'portable-service',region:'sfo'});
});
test('obsolete flags and infrastructure overrides cannot disable or redirect canonical discovery',()=>{
 const environment={RAILWAY_PROJECT_ID:'p',RAILWAY_ENVIRONMENT_ID:'e',RAILWAY_SERVICE_ID:'s',CONTROL_INFRASTRUCTURE_ENABLED:'0',CONTROL_PROVISION_WORKERS_ENABLED:'0',CONTROL_WORKSPACE_ID:'foreign',CONTROL_PUBLIC_URL:'https://foreign.invalid',CONTROL_WORKER_REGION:'foreign',CONTROL_WORKER_A_PROJECT_ID:'foreign'};
 const config=resolveControlRuntimeConfig(environment,true,false);assert.equal(config.gatewayEnabled,true);assert.equal(config.bootstrapEnabled,true);assert.equal(config.projectId,'p');assert.equal(config.region,'europe-west4-drams3a');
 configureApplicationEnvironment(environment,config);
 assert.equal('CONTROL_WORKSPACE_ID' in environment,false);assert.equal('CONTROL_INFRASTRUCTURE_ENABLED' in environment,false);assert.equal('CONTROL_PROVISION_WORKERS_ENABLED' in environment,false);
 assert.equal(environment.RAILWAY_PROJECT_ID,'p');assert.equal(environment.RAILWAY_SERVICE_ID,'s');
 assert.equal((environment as Record<string,string>).CONTROL_CLUSTER_BOOTSTRAP_ENABLED,'1');
});
test('explicit bootstrap maintenance opt-out preserves gateway and required runtime identity',()=>{
 const environment={RAILWAY_SERVICE_ID:'s',CONTROL_CLUSTER_BOOTSTRAP_ENABLED:'0'};
 const config=resolveControlRuntimeConfig(environment,true,false);assert.equal(config.bootstrapEnabled,false);assert.equal(config.gatewayEnabled,true);
 configureApplicationEnvironment(environment,config);assert.equal(environment.CONTROL_CLUSTER_BOOTSTRAP_ENABLED,'0');
});
test('existing Nodes keep gateway during credential outage without provisioning or local flag copies',()=>{
 const config=resolveControlRuntimeConfig({},false,true);assert.equal(config.gatewayEnabled,true);assert.equal(config.bootstrapEnabled,false);
 assert.equal(resolveControlRuntimeConfig({},false,false).gatewayEnabled,false);
});
