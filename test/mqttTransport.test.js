// The cloud transport against a real (in-process) MQTT broker: how it behaves
// while the broker is unreachable, and when the broker refuses it (issue #4).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createNetServer } from 'node:net';
import { Aedes } from 'aedes';

import { RoborockMqttTransport } from '../src/roborock/mqttTransport.js';

const RRIOT = { u: 'user-u', s: 'secret-s', h: 'hmac-h', k: 'key-k' };
const LOCAL_KEYS = new Map([['duid-abc', 'abcdef0123456789']]);
// fast enough for a test, same shape as the real delays
const BACKOFF = { min: 50, max: 200, unauthorized: 300 };

async function waitUntil(predicate, what, timeoutMs = 5000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

/**
 * Start a broker on the given port (0 = any free one), counting the connection
 * attempts it sees.
 * @param {number} port the port
 * @param {object} [options] Aedes options (e.g. authenticate)
 * @returns {Promise<object>} { aedes, server, port, attempts }
 */
async function startBroker(port, options = {}) {
  const aedes = await Aedes.createBroker(options);
  const server = createNetServer(aedes.handle);
  const broker = { aedes, server, attempts: 0, port: 0 };
  server.on('connection', () => {
    broker.attempts += 1;
  });
  await new Promise((resolve) => {
    server.listen(port, '127.0.0.1', resolve);
  });
  broker.port = server.address().port;
  return broker;
}

async function stopBroker(broker) {
  await new Promise((resolve) => {
    broker.aedes.close(resolve);
  });
  await new Promise((resolve) => {
    broker.server.close(resolve);
  });
}

async function freePort() {
  const server = createNetServer();
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => {
    server.close(resolve);
  });
  return port;
}

function transportFor(port, onStatus) {
  return new RoborockMqttTransport({ ...RRIOT, r: { m: `tcp://127.0.0.1:${port}` } }, LOCAL_KEYS, {
    onStatus,
    backoff: BACKOFF,
  });
}

test('requests made while the broker is unreachable never open a second client', async (t) => {
  const port = await freePort();
  const transport = transportFor(port);
  t.after(() => transport.disconnect());

  await assert.rejects(transport.connect(), /ECONNREFUSED/);
  const client = transport.client;

  // every poll of the robot asks for something: none may open its own client
  const requests = await Promise.allSettled(
    Array.from({ length: 20 }, () => transport.request('duid-abc', 'get_status')),
  );
  for (const result of requests) {
    assert.equal(result.status, 'rejected');
    assert.match(result.reason.message, /not connected/);
  }
  assert.equal(transport.client, client);

  const broker = await startBroker(port);
  t.after(() => stopBroker(broker));
  await waitUntil(() => client.connected, 'the reconnection');
  // a burst of connections is what gets an account refused: one client, one link
  assert.equal(broker.aedes.connectedClients, 1);
});

test('the retry delay grows while the broker stays unreachable', async (t) => {
  const port = await freePort();
  const transport = transportFor(port);
  t.after(() => transport.disconnect());

  await assert.rejects(transport.connect());
  await waitUntil(
    () => transport.client.options.reconnectPeriod === BACKOFF.max,
    'the delay to reach its ceiling',
  );
});

test('a broker refusal is reported once, waited out, then the recovery reported', async (t) => {
  let refuse = true;
  const statuses = [];
  const broker = await startBroker(0, {
    authenticate: (client, username, password, callback) => {
      if (refuse) {
        const err = new Error('Not authorized');
        err.returnCode = 5;
        callback(err, false);
        return;
      }
      callback(null, true);
    },
  });
  t.after(() => stopBroker(broker));
  const transport = transportFor(broker.port, (status) => statuses.push(status));
  t.after(() => transport.disconnect());

  await assert.rejects(transport.connect(), /Not authorized/);
  assert.deepEqual(statuses, ['unauthorized']);
  assert.equal(transport.client.options.reconnectPeriod, BACKOFF.unauthorized);
  await assert.rejects(transport.request('duid-abc', 'get_status'), /Not authorized/);

  // still refused on the next attempt: reported once, the long delay kept
  const attempts = broker.attempts;
  await waitUntil(() => broker.attempts > attempts, 'a second attempt');
  await new Promise((resolve) => {
    setTimeout(resolve, 50);
  });
  assert.deepEqual(statuses, ['unauthorized']);
  assert.equal(transport.client.options.reconnectPeriod, BACKOFF.unauthorized);

  refuse = false;
  await waitUntil(() => transport.client.connected, 'the reconnection');
  assert.deepEqual(statuses, ['unauthorized', 'connected']);
  assert.equal(transport.client.options.reconnectPeriod, BACKOFF.min);
});
