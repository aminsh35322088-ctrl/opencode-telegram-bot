import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isDistributedControl } from '../src/infrastructure/control-runtime-config.js';

const original = {
  ipc: process.env.CONTROL_APPLICATION_IPC,
  legacy: process.env.DISTRIBUTED_CONTROL_ENABLED,
};
function clear(): void {
  delete process.env.CONTROL_APPLICATION_IPC;
  delete process.env.DISTRIBUTED_CONTROL_ENABLED;
}
function restore(): void {
  if (original.ipc === undefined) delete process.env.CONTROL_APPLICATION_IPC;
  else process.env.CONTROL_APPLICATION_IPC = original.ipc;
  if (original.legacy === undefined) delete process.env.DISTRIBUTED_CONTROL_ENABLED;
  else process.env.DISTRIBUTED_CONTROL_ENABLED = original.legacy;
}

test('launcher worker IPC marks control as distributed', () => {
  clear();
  try {
    assert.equal(isDistributedControl(), false);
    process.env.CONTROL_APPLICATION_IPC = '1';
    assert.equal(isDistributedControl(), true);
    process.env.CONTROL_APPLICATION_IPC = '0';
    assert.equal(isDistributedControl(), false);
  } finally {
    restore();
  }
});

test('legacy DISTRIBUTED_CONTROL_ENABLED remains an explicit override', () => {
  clear();
  try {
    process.env.DISTRIBUTED_CONTROL_ENABLED = '1';
    assert.equal(isDistributedControl(), true);
    process.env.DISTRIBUTED_CONTROL_ENABLED = '0';
    assert.equal(isDistributedControl(), false);
    process.env.CONTROL_APPLICATION_IPC = '1';
    assert.equal(isDistributedControl(), true);
  } finally {
    restore();
  }
});
