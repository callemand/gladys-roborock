// The order in which the client tries the two transports, driven by the Gladys
// "Prefer the local connection" toggle. Both transports are stubbed: what is
// checked is which one is called first, and the fallback to the other one.

import test from 'node:test';
import assert from 'node:assert/strict';

import { RoborockAccountClient } from '../src/roborock/client.js';

const DUID = 'duid-abc';

/**
 * A client whose cloud and local transports record the calls they receive.
 * @param {object} [options] options
 * @param {boolean} [options.preferLocal] the toggle value
 * @param {boolean} [options.localFails] make the local transport throw
 * @param {boolean} [options.cloudFails] make the cloud transport throw
 * @returns {{ client: RoborockAccountClient, calls: string[] }} the client and the call log
 */
function stubbedClient({ preferLocal = true, localFails = false, cloudFails = false } = {}) {
  const calls = [];
  const client = new RoborockAccountClient({}, { preferLocal });
  client.mqtt = {
    async request(duid, method) {
      calls.push(`cloud:${method}`);
      if (cloudFails) {
        throw new Error('cloud down');
      }
      return 'from-cloud';
    },
  };
  client.localTransports.set(DUID, {
    async request(method) {
      calls.push(`local:${method}`);
      if (localFails) {
        throw new Error('local down');
      }
      return 'from-local';
    },
    disconnect() {},
  });
  return { client, calls };
}

test('local first by default', async () => {
  const { client, calls } = stubbedClient();
  assert.equal(await client.sendCommand(DUID, 'app_start'), 'from-local');
  assert.deepEqual(calls, ['local:app_start']);
  assert.equal(client.getLastTransport(DUID), 'local');
});

test('local first falls back to the cloud', async () => {
  const { client, calls } = stubbedClient({ localFails: true });
  assert.equal(await client.sendCommand(DUID, 'app_start'), 'from-cloud');
  assert.deepEqual(calls, ['local:app_start', 'cloud:app_start']);
  assert.equal(client.getLastTransport(DUID), 'cloud');
});

test('cloud first when the user turned the toggle off', async () => {
  const { client, calls } = stubbedClient({ preferLocal: false });
  assert.equal(await client.sendCommand(DUID, 'app_start'), 'from-cloud');
  assert.deepEqual(calls, ['cloud:app_start']);
  assert.equal(client.getLastTransport(DUID), 'cloud');
});

test('cloud first falls back to the local network', async () => {
  const { client, calls } = stubbedClient({ preferLocal: false, cloudFails: true });
  assert.equal(await client.sendCommand(DUID, 'app_start'), 'from-local');
  assert.deepEqual(calls, ['cloud:app_start', 'local:app_start']);
  assert.equal(client.getLastTransport(DUID), 'local');
});

test('cloud first rethrows the cloud error when no local transport is known', async () => {
  const { client } = stubbedClient({ preferLocal: false, cloudFails: true });
  client.localTransports.clear();
  // No LAN IP either: the IP lookup goes through the (failing) cloud.
  await assert.rejects(client.sendCommand(DUID, 'app_start'), /cloud down/);
});

test('the preference can change at runtime, without a new client', async () => {
  const { client, calls } = stubbedClient();
  client.setPreferLocal(false);
  await client.sendCommand(DUID, 'app_start');
  client.setPreferLocal(true);
  await client.sendCommand(DUID, 'app_stop');
  assert.deepEqual(calls, ['cloud:app_start', 'local:app_stop']);
});

test('the map follows the same preference', async () => {
  // Neither transport ever pushes the map frame: both attempts fail, and what is
  // checked is the order they were made in.
  for (const [preferLocal, expected] of [
    [true, ['local', 'cloud']],
    [false, ['cloud', 'local']],
  ]) {
    const calls = [];
    const client = new RoborockAccountClient({}, { preferLocal });
    client.rest.rriot = { k: 'key-k' };
    const noFrame = () => Promise.reject(new Error('no map frame'));
    client.mqtt = {
      armRawFrame: noFrame,
      async request() {
        calls.push('cloud');
      },
    };
    client.localTransports.set(DUID, {
      armRawFrame: noFrame,
      async request() {
        calls.push('local');
      },
      disconnect() {},
    });
    const result = await client.getRawMap(DUID);
    assert.equal(result.ok, false);
    assert.deepEqual(calls, expected);
    assert.deepEqual(
      result.attempts.map((attempt) => attempt.transport),
      expected,
    );
  }
});
