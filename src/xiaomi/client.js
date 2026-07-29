// -----------------------------------------------------------------------------
// Xiaomi/Roborock client.
//
// The Xiaomi account is linked once through a QR login (no password, no
// captcha) and the resulting session is persisted, so every later start
// reconnects silently. The cloud yields each robot's miIO local token + LAN IP,
// so commands then prefer the LOCAL transport (encrypted UDP) and fall back to
// a cloud RPC when the robot is not reachable on the LAN.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

import { XIAOMI_REGIONS } from '../constants.js';
import { MiCloudClient } from './miCloud.js';
import { MiioLocalTransport } from './miioLocalTransport.js';

const logger = createLogger({ name: 'xiaomi:client' });

const LOCAL_COOLDOWN_MS = 5 * 60 * 1000;

let rpcCounter = 1;

function nextRpcId() {
  rpcCounter += 1;
  if (rpcCounter >= 9999) {
    rpcCounter = 1;
  }
  return rpcCounter;
}

/**
 * Whether a Mi Home device is a robot vacuum.
 * @param {object} device a raw Mi Home device
 * @returns {boolean} true for vacuums
 */
function isVacuum(device) {
  return typeof device.model === 'string' && device.model.includes('vacuum');
}

export class RoborockClient {
  /**
   * @param {object} [session] the persisted Xiaomi session (see session.js).
   *   Everything the integration needs is discovered or remembered — there is
   *   no user-facing configuration at all.
   */
  constructor(session = {}) {
    this.session = session;
    this.cloud = null;
    this.devices = [];
    this.tokens = new Map(); // duid -> Buffer token
    this.localIps = new Map(); // duid -> ip
    this.localTransports = new Map(); // duid -> MiioLocalTransport
    this.localCooldownUntil = new Map(); // duid -> timestamp
    this.lastTransport = new Map(); // duid -> 'local' | 'cloud'
  }

  isLoggedIn() {
    return this.devices.length > 0 || (this.cloud !== null && this.cloud.isLoggedIn());
  }

  /**
   * Restore the Xiaomi session (silent passToken login) and load the robots.
   */
  async login() {
    await this.#loginCloud();
  }

  /**
   * The Mi Home cloud client, created on demand.
   * @returns {MiCloudClient} the cloud client
   */
  getCloud() {
    if (!this.cloud) {
      this.cloud = new MiCloudClient(this.session.region || 'de', this.session);
    }
    return this.cloud;
  }

  /**
   * Start linking the Xiaomi account: returns the URL / QR the user must open
   * and approve with the Xiaomi Home app.
   * @returns {Promise<{ loginUrl: string, qrUrl: string, expiresIn: number }>} the prompt
   */
  async startAccountLink() {
    return this.getCloud().startQrLogin();
  }

  /**
   * Await the approval of a pending account link (one long-poll leg).
   * @returns {Promise<boolean>} true once linked
   */
  async pollAccountLink() {
    const linked = await this.getCloud().pollQrLogin();
    if (linked) {
      this.session = this.cloud.getSession();
      await this.#loadCloudDevices();
    }
    return linked;
  }

  /**
   * Whether an account link is waiting for the user's approval.
   * @returns {boolean} true while pending
   */
  hasPendingAccountLink() {
    return Boolean(this.cloud && this.cloud.hasPendingQrLogin());
  }

  /**
   * The session worth persisting (see src/xiaomi/session.js).
   * @returns {object|null} the session, or null when never connected
   */
  getSession() {
    return this.cloud ? this.cloud.getSession() : null;
  }

  // --- Cloud session ---------------------------------------------------------

  /**
   * The regions to try, most likely first: the one remembered from the last
   * successful discovery (so a restart does not probe them all again), then the
   * usual ones. The region is never asked of the user.
   * @returns {Array<string>} the region codes to try in order
   */
  #candidateRegions() {
    const known = this.session.region;
    if (known) {
      return [known, ...XIAOMI_REGIONS.filter((r) => r !== known)];
    }
    return XIAOMI_REGIONS;
  }

  async #loginCloud() {
    const cloud = this.getCloud();
    if (!cloud.canLoginSilently()) {
      throw new Error('Xiaomi account not linked yet: run the "Link the Xiaomi account" action');
    }
    await cloud.loginWithPassToken();
    this.session = cloud.getSession();
    await this.#loadCloudDevices();
  }

  /**
   * Load the account robots (with their local token + IP) from the cloud,
   * trying each region until they are found.
   */
  async #loadCloudDevices() {
    let found = [];
    for (const region of this.#candidateRegions()) {
      this.cloud.region = region;
      let list;
      try {
        list = await this.cloud.getDevices();
      } catch (e) {
        logger.debug(`device_list failed in region ${region}: ${e.message}`);
        continue;
      }
      const vacuums = list.filter(isVacuum);
      if (vacuums.length > 0) {
        logger.info(`${vacuums.length} robot(s) found in region ${region}`);
        found = vacuums;
        // Remember it: persisted with the session, tried first next time.
        this.session = { ...this.session, region };
        break;
      }
    }

    this.devices = found.map((device) => ({
      duid: String(device.did),
      name: device.name || String(device.did),
      model: device.model || null,
      online: device.isOnline !== false,
    }));
    this.tokens = new Map();
    this.localIps = new Map();
    found.forEach((device) => {
      const duid = String(device.did);
      if (device.token) {
        this.tokens.set(duid, Buffer.from(device.token, 'hex'));
      }
      if (device.localip) {
        this.localIps.set(duid, device.localip);
      }
    });
  }

  // --- Common ----------------------------------------------------------------

  /**
   * The robot vacuums.
   * @returns {Array<object>} the device list
   */
  listDevices() {
    return this.devices;
  }

  /**
   * Fetch the live status of one robot.
   * @param {string} duid the device id
   * @returns {Promise<object>} the get_status result
   */
  async getStatus(duid) {
    const result = await this.#execute(duid, 'get_status', []);
    return Array.isArray(result) ? result[0] : result;
  }

  /**
   * Forward an RPC command to one robot.
   * @param {string} duid the device id
   * @param {string} method the miIO method
   * @param {Array|object} [params] the method params
   * @returns {Promise<*>} the RPC result
   */
  async sendCommand(duid, method, params = []) {
    return this.#execute(duid, method, params);
  }

  /**
   * The transport used for the last RPC of a device ('local' or 'cloud').
   * @param {string} duid the device id
   * @returns {string|null} the transport, or null if none yet
   */
  getLastTransport(duid) {
    return this.lastTransport.get(duid) || null;
  }

  async #execute(duid, method, params) {
    const local = this.#getLocalTransport(duid);
    if (local) {
      try {
        const result = await local.request(method, params);
        this.lastTransport.set(duid, 'local');
        return result;
      } catch (e) {
        if (!this.cloud) {
          throw e; // local mode: no fallback
        }
        logger.warn(`Local request failed for ${duid}, falling back to cloud: ${e.message}`);
        this.#coolDownLocal(duid);
      }
    }
    if (!this.cloud) {
      throw new Error(`Robot ${duid} is not reachable locally`);
    }
    const result = await this.cloud.rpc(duid, { id: nextRpcId(), method, params });
    this.lastTransport.set(duid, 'cloud');
    return result;
  }

  #getLocalTransport(duid) {
    if (Date.now() < (this.localCooldownUntil.get(duid) || 0)) {
      return null;
    }
    if (this.localTransports.has(duid)) {
      return this.localTransports.get(duid);
    }
    const ip = this.localIps.get(duid);
    const token = this.tokens.get(duid);
    if (!ip || !token) {
      this.#coolDownLocal(duid);
      return null;
    }
    const transport = new MiioLocalTransport(ip, token);
    this.localTransports.set(duid, transport);
    return transport;
  }

  #coolDownLocal(duid) {
    this.localCooldownUntil.set(duid, Date.now() + LOCAL_COOLDOWN_MS);
    const transport = this.localTransports.get(duid);
    if (transport) {
      transport.disconnect();
      this.localTransports.delete(duid);
    }
  }

  /**
   * Log out and close every transport.
   */
  async logout() {
    for (const transport of this.localTransports.values()) {
      transport.disconnect();
    }
    this.localTransports.clear();
    if (this.cloud) {
      this.cloud.logout();
      this.cloud = null;
    }
    this.devices = [];
    this.tokens = new Map();
  }
}
