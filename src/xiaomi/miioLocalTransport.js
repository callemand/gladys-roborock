// -----------------------------------------------------------------------------
// miIO local transport (UDP on port 54321).
//
// Talks to the device directly on the LAN with the token discovered from the
// Mi Home cloud: a handshake syncs the device clock, then each RPC is a packet
// stamped with (device ts + 1s), correlated to its reply by the RPC id.
//
// Best-effort: any handshake/response failure is surfaced to the caller
// (src/xiaomi/client.js), which falls back to the cloud.
// -----------------------------------------------------------------------------

import dgram from 'node:dgram';

import { createLogger } from '@gladysassistant/integration-sdk';

import { MIIO_PORT } from '../constants.js';
import { HELLO_PACKET, buildPacket, parsePacket } from './miioPacket.js';

const logger = createLogger({ name: 'xiaomi:miio' });

const HANDSHAKE_TIMEOUT_MS = 5000;
const RESPONSE_TIMEOUT_MS = 5000;
// Re-handshake if the last device-clock sync is older than this.
const HANDSHAKE_TTL_MS = 20000;

// The device IGNORES a request whose id it has recently seen, so the counter
// must NOT restart from a low value on every process start (verified against a
// real Roborock S6: id=2 got no reply after a previous session, id=100+ did).
// Seeding from the clock keeps ids increasing across restarts.
let requestCounter = 10000 + (Math.floor(Date.now() / 1000) % 20000);

function nextId() {
  requestCounter += 1;
  if (requestCounter >= 32767) {
    requestCounter = 10000;
  }
  return requestCounter;
}

export class MiioLocalTransport {
  /**
   * @param {string} ip the device LAN IP
   * @param {Buffer} token the 16-byte device token
   * @param {number} [port] the UDP port (defaults to the miIO port)
   */
  constructor(ip, token, port = MIIO_PORT) {
    this.ip = ip;
    this.token = token;
    this.port = port;
    this.socket = null;
    this.deviceId = null;
    this.deviceTs = 0;
    this.handshakeAt = 0;
    this.pending = new Map(); // id -> { resolve, reject, timer }
    this.handshakeWaiter = null;
  }

  #ensureSocket() {
    if (this.socket) {
      return;
    }
    const socket = dgram.createSocket('udp4');
    socket.on('message', (msg) => this.#onMessage(msg));
    socket.on('error', (err) => logger.debug(`UDP socket error: ${err.message}`));
    this.socket = socket;
  }

  #onMessage(msg) {
    let parsed;
    try {
      parsed = parsePacket(msg, this.token);
    } catch (e) {
      logger.debug(`Failed to parse a miIO packet: ${e.message}`);
      return;
    }
    // Handshake reply: empty payload.
    if (!parsed.payload || parsed.payload.length === 0) {
      this.deviceId = parsed.deviceId;
      this.deviceTs = parsed.ts;
      this.handshakeAt = Date.now();
      if (this.handshakeWaiter) {
        this.handshakeWaiter.resolve();
        this.handshakeWaiter = null;
      }
      return;
    }
    this.deviceTs = parsed.ts;
    let json;
    try {
      json = JSON.parse(parsed.payload.toString('utf8'));
    } catch (e) {
      logger.debug(`Failed to parse a miIO payload: ${e.message}`);
      return;
    }
    const waiter = this.pending.get(json.id);
    if (!waiter) {
      return;
    }
    clearTimeout(waiter.timer);
    this.pending.delete(json.id);
    if (json.error) {
      waiter.reject(new Error(`miIO error: ${JSON.stringify(json.error)}`));
    } else {
      waiter.resolve(json.result);
    }
  }

  /**
   * Sync the device clock (handshake), unless a recent one is still valid.
   * @returns {Promise<void>} resolves once handshaked
   */
  async #handshake() {
    if (this.deviceId && Date.now() - this.handshakeAt < HANDSHAKE_TTL_MS) {
      return;
    }
    this.#ensureSocket();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.handshakeWaiter = null;
        reject(new Error(`miIO handshake with ${this.ip} timed out`));
      }, HANDSHAKE_TIMEOUT_MS);
      this.handshakeWaiter = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      };
      this.socket.send(HELLO_PACKET, this.port, this.ip, (err) => {
        if (err) {
          clearTimeout(timer);
          this.handshakeWaiter = null;
          reject(err);
        }
      });
    });
  }

  /**
   * Send an RPC command over the local connection and await its response.
   * @param {string} method the miIO method
   * @param {Array|object} [params] the method params
   * @returns {Promise<*>} the RPC result
   */
  async request(method, params = []) {
    await this.#handshake();
    const id = nextId();
    const payload = Buffer.from(JSON.stringify({ id, method, params }));
    const packet = buildPacket({
      deviceId: this.deviceId,
      ts: this.deviceTs + 1,
      token: this.token,
      payload,
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`miIO local request timed out: ${method} on ${this.ip}`));
      }, RESPONSE_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(packet, this.port, this.ip, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  /**
   * Close the UDP socket and reject every pending request.
   */
  disconnect() {
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('miIO local transport closed'));
    }
    this.pending.clear();
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.deviceId = null;
    this.handshakeAt = 0;
  }
}
