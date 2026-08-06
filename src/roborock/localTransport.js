// -----------------------------------------------------------------------------
// Roborock local transport (TCP, port 58867).
//
// Same message framing as the cloud, plus a 4-byte big-endian length prefix per
// frame. Best-effort: any failure is surfaced to src/roborock/client.js, which
// falls back to the cloud.
// -----------------------------------------------------------------------------

import net from 'node:net';

import { createLogger } from '@gladysassistant/integration-sdk';

import { ROBOROCK_LOCAL_PORT, ROBOROCK_MESSAGE_PROTOCOL } from '../constants.js';
import {
  buildRequestPayload,
  decodePrefixedStream,
  encodeMessage,
  nextRequestId,
  parseResponsePayload,
} from './message.js';

const logger = createLogger({ name: 'roborock:local' });

const CONNECT_TIMEOUT_MS = 5000;
const RESPONSE_TIMEOUT_MS = 8000;

export class RoborockLocalTransport {
  /**
   * @param {string} duid the device id (for logging)
   * @param {string} ip the robot LAN IP
   * @param {string} localKey the device local key
   * @param {number} [port] the TCP port
   */
  constructor(duid, ip, localKey, port = ROBOROCK_LOCAL_PORT) {
    this.duid = duid;
    this.ip = ip;
    this.localKey = localKey;
    this.port = port;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map(); // id -> { resolve, reject, timer }
  }

  isConnected() {
    return this.socket !== null && !this.socket.destroyed;
  }

  /**
   * Open the TCP connection to the robot.
   */
  async connect() {
    if (this.isConnected()) {
      return;
    }
    await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.ip, port: this.port });
      socket.setTimeout(CONNECT_TIMEOUT_MS);

      const onConnect = () => {
        socket.setTimeout(0);
        socket.removeListener('error', onError);
        socket.removeListener('timeout', onTimeout);
        this.socket = socket;
        this.buffer = Buffer.alloc(0);
        socket.on('data', (data) => this.#onData(data));
        socket.on('error', (err) => this.#onClose(err));
        socket.on('close', () => this.#onClose(new Error('local socket closed')));
        resolve();
      };
      const onError = (err) => {
        socket.destroy();
        reject(err);
      };
      const onTimeout = () => {
        socket.destroy();
        reject(new Error(`Local connection to ${this.ip} timed out`));
      };
      socket.once('connect', onConnect);
      socket.once('error', onError);
      socket.once('timeout', onTimeout);
    });
    logger.debug(`Local connection established with ${this.duid} (${this.ip})`);
  }

  /**
   * Send an RPC command over the local connection and await its answer.
   * @param {string} method the Roborock method
   * @param {Array|object} [params] the method params
   * @returns {Promise<*>} the RPC result
   */
  async request(method, params = []) {
    await this.connect();
    const id = nextRequestId();
    const timestamp = Math.floor(Date.now() / 1000);
    const message = encodeMessage({
      protocol: ROBOROCK_MESSAGE_PROTOCOL.RPC_REQUEST,
      payload: buildRequestPayload({ id, method, params, timestamp }),
      localKey: this.localKey,
      timestamp,
      prefixed: true,
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Roborock local request timed out: ${method} on ${this.duid}`));
      }, RESPONSE_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(message, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  #onData(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    let decoded;
    try {
      decoded = decodePrefixedStream(this.buffer, this.localKey);
    } catch (e) {
      logger.debug(`Failed to decode a local message from ${this.duid}: ${e.message}`);
      this.buffer = Buffer.alloc(0);
      return;
    }
    this.buffer = decoded.rest;
    decoded.messages.forEach((message) => {
      if (message.protocol !== ROBOROCK_MESSAGE_PROTOCOL.RPC_RESPONSE) {
        return;
      }
      const response = parseResponsePayload(message.payload);
      if (!response || response.id === null) {
        return;
      }
      const waiter = this.pending.get(response.id);
      if (!waiter) {
        return;
      }
      clearTimeout(waiter.timer);
      this.pending.delete(response.id);
      if (response.error) {
        waiter.reject(new Error(`Roborock error: ${JSON.stringify(response.error)}`));
      } else {
        waiter.resolve(response.result);
      }
    });
  }

  #onClose(err) {
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    this.pending.clear();
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }

  /**
   * Close the local connection.
   */
  disconnect() {
    this.#onClose(new Error('Roborock local transport closed'));
  }
}
