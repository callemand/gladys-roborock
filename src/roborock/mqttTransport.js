// -----------------------------------------------------------------------------
// Roborock cloud transport (MQTT), the same channel the mobile app uses.
//
//   - broker URL and credentials are derived from the rriot credentials;
//   - one topic pair per device: `rr/m/i/...` to publish a command,
//     `rr/m/o/...` to receive the answer;
//   - each command is a protocol-101 message, correlated to its protocol-102
//     answer by the RPC id.
//
// ONE client per transport, reconnecting on its own with a growing delay. The
// broker treats a burst of connections as abuse and answers every later one with
// `Connection refused: Not authorized` (rc 5), the same refusal as for revoked
// credentials (issue #4). Opening a new client per request while the broker was
// unreachable, each one retrying every 5 s and none ever closed, made exactly
// such a burst: the logs of that issue show a dozen of them failing at once.
// -----------------------------------------------------------------------------

import mqtt from 'mqtt';

import { createLogger } from '@gladysassistant/integration-sdk';

import { ROBOROCK_MESSAGE_PROTOCOL } from '../constants.js';
import { md5hex } from './crypto.js';
import {
  buildRequestPayload,
  decodeMessage,
  encodeMessage,
  nextRequestId,
  parseResponsePayload,
} from './message.js';

const logger = createLogger({ name: 'roborock:mqtt' });

const RESPONSE_TIMEOUT_MS = 15000;
// Reconnect delays, the values python-roborock settled on for the same broker: a
// first retry after 10 s, then 1.5x longer each time it fails.
const MIN_BACKOFF_MS = 10 * 1000;
const MAX_BACKOFF_MS = 10 * 60 * 1000;
const BACKOFF_MULTIPLIER = 1.5;
// After a `Not authorized`, retrying soon only extends the refusal.
const UNAUTHORIZED_BACKOFF_MS = 60 * 60 * 1000;
// CONNACK return code 5 (MQTT 3.1.1).
const RC_NOT_AUTHORIZED = 5;

/**
 * Translate the rriot MQTT URL scheme to the one mqtt.js expects.
 * @param {string} url the rriot.r.m URL (e.g. ssl://host:8883)
 * @returns {string} the mqtt.js URL
 */
function toMqttUrl(url) {
  return url.replace(/^ssl:\/\//, 'mqtts://').replace(/^tcp:\/\//, 'mqtt://');
}

export class RoborockMqttTransport {
  /**
   * @param {object} rriot the rriot credentials (u, s, k, r { m })
   * @param {Map<string, string>} localKeys map of duid -> localKey
   * @param {object} [options] options
   * @param {Function} [options.onStatus] called with 'connected' on every
   *   (re)connection and 'unauthorized' when the broker refuses the credentials
   * @param {object} [options.backoff] reconnect delays in ms ({ min, max,
   *   unauthorized }), overridden by the tests only
   */
  constructor(rriot, localKeys, { onStatus = () => {}, backoff = {} } = {}) {
    this.rriot = rriot;
    this.localKeys = localKeys;
    // Credentials are substrings of the HEX digests, not base64.
    this.username = md5hex(`${rriot.u}:${rriot.k}`).slice(2, 10);
    this.password = md5hex(`${rriot.s}:${rriot.k}`).slice(16);
    this.client = null;
    this.pending = new Map(); // `${duid}:${id}` -> { resolve, reject, timer }
    this.rawWaiters = []; // one-shot waiters for non-102 frames (e.g. 301 map)
    this.onStatus = onStatus;
    this.backoff = {
      min: MIN_BACKOFF_MS,
      max: MAX_BACKOFF_MS,
      unauthorized: UNAUTHORIZED_BACKOFF_MS,
      ...backoff,
    };
    this.unauthorized = false;
    this.lastError = null;
  }

  publishTopic(duid) {
    return `rr/m/i/${this.rriot.u}/${this.username}/${duid}`;
  }

  subscribeTopic(duid) {
    return `rr/m/o/${this.rriot.u}/${this.username}/${duid}`;
  }

  /**
   * Connect to the broker and subscribe to every known device topic.
   *
   * The client is created once. If this first attempt fails it is kept, and
   * keeps retrying in the background; so does it after any later disconnection.
   * mqtt.js then restores the subscriptions by itself.
   */
  async connect() {
    if (this.client) {
      if (this.client.connected) {
        return;
      }
      throw this.#notConnectedError();
    }
    const url = toMqttUrl(this.rriot.r.m);
    logger.debug(`Connecting to the Roborock broker ${url}`);
    const client = mqtt.connect(url, {
      username: this.username,
      password: this.password,
      // MQTT 3.1.1: accepted by the Roborock broker and the widest-compatible.
      protocolVersion: 4,
      clean: true,
      // read again by mqtt.js before every retry: the handlers below grow it
      reconnectPeriod: this.backoff.min,
      connectTimeout: RESPONSE_TIMEOUT_MS,
    });
    this.client = client;
    client.on('message', (topic, message) => this.#onMessage(topic, message));
    client.on('connect', () => this.#onConnect(client));
    client.on('error', (err) => this.#onError(client, err));
    client.on('reconnect', () => this.#growBackoff(client));

    await new Promise((resolve, reject) => {
      const onError = (err) => {
        client.removeListener('connect', onConnect);
        reject(err);
      };
      const onConnect = () => {
        client.removeListener('error', onError);
        resolve();
      };
      client.once('connect', onConnect);
      client.once('error', onError);
    });

    const topics = [...this.localKeys.keys()].map((duid) => this.subscribeTopic(duid));
    if (topics.length > 0) {
      await new Promise((resolve, reject) => {
        this.client.subscribe(topics, { qos: 0 }, (err) => (err ? reject(err) : resolve()));
      });
    }
  }

  #onConnect(client) {
    const wasRefused = this.unauthorized;
    this.unauthorized = false;
    this.lastError = null;
    client.options.reconnectPeriod = this.backoff.min;
    logger.info(
      wasRefused
        ? 'Roborock cloud accepted the connection again'
        : 'Connected to the Roborock cloud',
    );
    this.onStatus('connected');
  }

  #onError(client, err) {
    if (err.code === RC_NOT_AUTHORIZED) {
      client.options.reconnectPeriod = this.backoff.unauthorized;
      if (!this.unauthorized) {
        this.unauthorized = true;
        this.onStatus('unauthorized');
      }
    }
    // once per kind of failure, not once per attempt
    const message = err.message || err.code || String(err);
    if (message !== this.lastError) {
      this.lastError = message;
      logger.warn(
        `MQTT error ${message}, retrying in ${Math.round(client.options.reconnectPeriod / 1000)} s`,
      );
    }
  }

  #growBackoff(client) {
    // called as an attempt starts: it sets the delay before the NEXT one
    if (this.unauthorized) {
      return;
    }
    const period = client.options.reconnectPeriod * BACKOFF_MULTIPLIER;
    client.options.reconnectPeriod = Math.min(Math.round(period), this.backoff.max);
  }

  #notConnectedError() {
    const seconds = Math.round(this.client.options.reconnectPeriod / 1000);
    return new Error(
      this.unauthorized
        ? `Roborock refuses the cloud connection (Not authorized), next attempt within ${seconds} s`
        : `Roborock cloud not connected, next attempt within ${seconds} s`,
    );
  }

  /**
   * Send an RPC command to a device and await its answer.
   * @param {string} duid the device id
   * @param {string} method the Roborock method
   * @param {Array|object} [params] the method params
   * @param {object} [extra] extra inner RPC keys (e.g. map `security`)
   * @returns {Promise<*>} the RPC result
   */
  async request(duid, method, params = [], extra = null) {
    // never a second client: while this one reconnects, fail fast
    await this.connect();
    const localKey = this.localKeys.get(duid);
    if (!localKey) {
      throw new Error(`Unknown Roborock device "${duid}" (no local key)`);
    }
    const id = nextRequestId();
    const timestamp = Math.floor(Date.now() / 1000);
    const message = encodeMessage({
      protocol: ROBOROCK_MESSAGE_PROTOCOL.RPC_REQUEST,
      payload: buildRequestPayload({ id, method, params, timestamp, extra }),
      localKey,
      timestamp,
      prefixed: false,
    });

    return new Promise((resolve, reject) => {
      const key = `${duid}:${id}`;
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`Roborock cloud request timed out: ${method} on ${duid}`));
      }, RESPONSE_TIMEOUT_MS);
      this.pending.set(key, { resolve, reject, timer });

      this.client.publish(this.publishTopic(duid), message, { qos: 0 }, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(key);
          reject(err);
        }
      });
    });
  }

  /**
   * Arm a one-shot waiter for the next non-102 frame of a device (e.g. the 301
   * map push that follows a get_map_v1). The frame is returned with its
   * layer-1-decrypted payload, uncorrupted, for the caller to decode/diagnose.
   * @param {string} duid the device id
   * @param {number} protocol the awaited frame protocol (e.g. 301)
   * @param {number} [timeoutMs] how long to wait
   * @returns {Promise<object>} the decoded frame ({ protocol, timestamp, payload, ... })
   */
  armRawFrame(duid, protocol, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const waiter = { duid, protocol, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.rawWaiters = this.rawWaiters.filter((w) => w !== waiter);
        reject(new Error(`Roborock raw frame (protocol ${protocol}) timed out on ${duid}`));
      }, timeoutMs);
      this.rawWaiters.push(waiter);
    });
  }

  #dispatchRawFrame(duid, message) {
    const index = this.rawWaiters.findIndex(
      (w) => w.duid === duid && w.protocol === message.protocol,
    );
    if (index === -1) {
      return;
    }
    const [waiter] = this.rawWaiters.splice(index, 1);
    clearTimeout(waiter.timer);
    waiter.resolve(message);
  }

  #onMessage(topic, message) {
    // The topic tail is the device id.
    const duid = topic.split('/').pop();
    const localKey = this.localKeys.get(duid);
    if (!localKey) {
      return;
    }
    let decoded;
    try {
      decoded = decodeMessage(message, localKey);
    } catch (e) {
      logger.debug(`Failed to decode a cloud message from ${duid}: ${e.message}`);
      return;
    }
    if (decoded.protocol !== ROBOROCK_MESSAGE_PROTOCOL.RPC_RESPONSE) {
      // Map data and other pushes (e.g. 301): hand them to a raw-frame waiter if
      // one is armed, otherwise ignore them as before.
      this.#dispatchRawFrame(duid, decoded);
      return;
    }
    const response = parseResponsePayload(decoded.payload);
    if (!response || response.id === null) {
      return;
    }
    const waiter = this.pending.get(`${duid}:${response.id}`);
    if (!waiter) {
      return;
    }
    clearTimeout(waiter.timer);
    this.pending.delete(`${duid}:${response.id}`);
    if (response.error) {
      waiter.reject(new Error(`Roborock error: ${JSON.stringify(response.error)}`));
    } else {
      waiter.resolve(response.result);
    }
  }

  /**
   * Disconnect and reject every pending request.
   */
  async disconnect() {
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('Roborock cloud transport closed'));
    }
    this.pending.clear();
    for (const waiter of this.rawWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('Roborock cloud transport closed'));
    }
    this.rawWaiters = [];
    if (this.client) {
      await new Promise((resolve) => this.client.end(true, {}, resolve));
      this.client = null;
    }
  }
}
