import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

const text=(path:string)=>readFileSync(path,'utf8');

test('Railway launcher owns the infrastructure credential and starts the privileged control boundary',()=>{
  const launcher=text('src/infrastructure/launcher.ts');
  assert.match(launcher,/createInfrastructureClient\(process\.env\)/);
  const dockerfile=text('Dockerfile');
  assert.match(dockerfile,/CMD \["node", "\/app\/dist\/infrastructure\/launcher\.js"\]/);
});
