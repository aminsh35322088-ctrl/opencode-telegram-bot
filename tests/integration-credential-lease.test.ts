import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IntegrationCredentialLeaseBroker } from '../src/control-plane/integration-credential-lease.js';

const owner = { nodeId: 'worker', generation: 1, chatId: -100, threadId: 42, sessionId: 'session' };
const githubPayload = (overrides = {}) => ({
  workerId: 'worker',
  topicId: '-100:42',
  generation: 1,
  sessionId: 'session',
  integrationId: 'github',
  credentialId: 'amin',
  ...overrides,
});
const dependencies = {
  githubCredential: async () => 'ghp_fixture_token',
  tailscaleAuthKey: async () => 'tskey-auth-fixture',
};
const broker = () => new IntegrationCredentialLeaseBroker({ ...dependencies, now: () => 1_000 });

test('github session.access without resource is issued and fenced', async () => {
  const result = await broker().acquire(githubPayload({ capability: 'session.access', scopes: ['session.access'] }), owner);
  assert.equal(typeof result.leaseId, 'string');
  assert.equal(result.value, 'ghp_fixture_token');
  assert.ok(result.expiresAt > 1_000);
});

test('github session.access with a resource or foreign scope is denied', async () => {
  const denied = broker();
  await assert.rejects(denied.acquire(
    githubPayload({ capability: 'session.access', scopes: ['session.access'], resource: 'owner/repo' }), owner));
  await assert.rejects(denied.acquire(
    githubPayload({ capability: 'session.access', scopes: ['repo.read'] }), owner));
  await assert.rejects(denied.acquire(
    githubPayload({ capability: 'repo.read', scopes: ['repo.read'] }), owner));
});

test('github repository capabilities still require an exact repository resource', async () => {
  const ok = await broker().acquire(
    githubPayload({ capability: 'repo.read', scopes: ['repo.read'], resource: 'owner/repo' }), owner);
  assert.equal(ok.value, 'ghp_fixture_token');
  await assert.rejects(broker().acquire(
    githubPayload({ capability: 'session.access', scopes: ['session.access'], credentialId: 'Bad_Account' }), owner));
});

test('session.access leases validate and release for the exact owner only', async () => {
  const subject = broker();
  const { leaseId } = await subject.acquire(
    githubPayload({ capability: 'session.access', scopes: ['session.access'] }), owner);
  assert.deepEqual(await subject.validate({ leaseId }, owner), { valid: true });
  assert.deepEqual(await subject.validate({ leaseId }, { ...owner, sessionId: 'other' }), { valid: false });
  assert.deepEqual(await subject.release({ leaseId }, owner), { released: true });
  assert.deepEqual(await subject.validate({ leaseId }, owner), { valid: false });
});
