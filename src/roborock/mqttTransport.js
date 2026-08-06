// -----------------------------------------------------------------------------
// Roborock cloud transport (MQTT), the same channel the mobile app uses.
//
//   - broker URL and credentials are derived from the rriot credentials;
//   - one topic pair per device: `rr/m/i/...` to publish a command,
//     `rr/m/o/...` to receive the answer;
//   - each command is a protocol-101 message, correlated to its protocol-102
//     answer by the RPC id.
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
   */
  constructor(rriot, localKeys) {
    this.rriot = rriot;
    this.localKeys = localKeys;
    // Credentials are substrings of the HEX digests, not base64.
    this.username = md5hex(`${rriot.u}:${rriot.k}`).slice(2, 10);
    this.password = md5hex(`${rriot.s}:${rriot.k}`).slice(16);
    this.client = null;
    this.pending = new Map(); // `${duid}:${id}` -> { resolve, reject, timer }
  }

  publishTopic(duid) {
    return `rr/m/i/${this.rriot.u}/${this.username}/${duid}`;
  }

  subscribeTopic(duid) {
    return `rr/m/o/${this.rriot.u}/${this.username}/${duid}`;
  }

  /**
   * Connect to the broker and subscribe to every known device topic.
   */
  async connect() {
    if (this.client && this.client.connected) {
      return;
    }
    const url = toMqttUrl(this.rriot.r.m);
    logger.debug(`Connecting to the Roborock broker ${url}`);
    await new Promise((resolve, reject) => {
      const client = mqtt.connect(url, {
        username: this.username,
        password: this.password,
        // MQTT 3.1.1: accepted by the Roborock broker and the widest-compatible.
        protocolVersion: 4,
        clean: true,
        reconnectPeriod: 5000,
        connectTimeout: RESPONSE_TIMEOUT_MS,
      });
      this.client = client;

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
      client.on('message', (topic, message) => this.#onMessage(topic, message));
      client.on('error', (err) => logger.warn('MQTT error', err.message));
    });

    const topics = [...this.localKeys.keys()].map((duid) => this.subscribeTopic(duid));
    if (topics.length > 0) {
      await new Promise((resolve, reject) => {
        this.client.subscribe(topics, { qos: 0 }, (err) => (err ? reject(err) : resolve()));
      });
    }
    logger.info('Connected to the Roborock cloud');
  }

  /**
   * Send an RPC command to a device and await its answer.
   * @param {string} duid the device id
   * @param {string} method the Roborock method
   * @param {Array|object} [params] the method params
   * @returns {Promise<*>} the RPC result
   */
  async request(duid, method, params = []) {
    if (!this.client || !this.client.connected) {
      await this.connect();
    }
    const localKey = this.localKeys.get(duid);
    if (!localKey) {
      throw new Error(`Unknown Roborock device "${duid}" (no local key)`);
    }
    const id = nextRequestId();
    const timestamp = Math.floor(Date.now() / 1000);
    const message = encodeMessage({
      protocol: ROBOROCK_MESSAGE_PROTOCOL.RPC_REQUEST,
      payload: buildRequestPayload({ id, method, params, timestamp }),
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
      return; // map data and unsolicited pushes are ignored
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
    if (this.client) {
      await new Promise((resolve) => this.client.end(true, {}, resolve));
      this.client = null;
    }
  }
}
