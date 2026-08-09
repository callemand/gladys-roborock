// -----------------------------------------------------------------------------
// Roborock account client — for robots paired in the ROBOROCK app.
//
// Exposes the SAME public interface as the Xiaomi client (src/xiaomi/client.js)
// so index.js can hold either one without knowing which cloud is behind:
//   login / isLoggedIn / listDevices / getStatus / sendCommand /
//   getLastTransport / getSession / logout
//
// The account is linked once from the credentials the user saved, then the
// session (token + rriot credentials) is persisted and reused silently. Commands
// prefer the LOCAL transport (TCP) when the robot's LAN IP is known, and fall
// back to the cloud (MQTT).
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

import { RoborockLocalTransport } from './localTransport.js';
import { RoborockMqttTransport } from './mqttTransport.js';
import { RoborockRestClient } from './restClient.js';

const logger = createLogger({ name: 'roborock:client' });

const LOCAL_COOLDOWN_MS = 5 * 60 * 1000;

// Set as `error.reason` on a login failure, so index.js can phrase it in the
// user's language instead of forwarding an English sentence.
export const CREDENTIALS_REFUSED = 'roborock_credentials_refused';
export const CODE_REFUSED = 'roborock_code_refused';
export const TWO_STEP_REQUIRED = 'roborock_two_step_required';
// What the Roborock API answers for "username or password error", and for
// "need two-step validate" — the latter means the password WAS accepted and a
// code sent to the account owner is required on top of it.
const BAD_CREDENTIALS_CODE = 2012;
const TWO_STEP_CODE = 2031;
// `email code error`: the code is wrong, already used, or expired. Seen on a live
// account with a code an hour old.
const EMAIL_CODE_ERROR = 2018;

/**
 * Whether a Roborock home device is a robot vacuum. The Roborock account also
 * carries dock accessories and, on some accounts, non-vacuum products.
 * @param {object} device a raw home device
 * @param {Map<string, object>} products the products by id
 * @returns {boolean} true for vacuums
 */
function isVacuum(device, products) {
  const product = products.get(device.productId) || {};
  const model = product.model || '';
  const category = product.category || '';
  return model.includes('vacuum') || category.includes('vacuum') || model.startsWith('roborock.');
}

export class RoborockAccountClient {
  /**
   * @param {object} [session] the persisted Roborock session (see session.js)
   */
  constructor(session = {}) {
    this.rest = new RoborockRestClient(session);
    this.mqtt = null;
    this.devices = [];
    this.localKeys = new Map(); // duid -> localKey
    this.localIps = new Map(); // duid -> ip
    this.localTransports = new Map(); // duid -> RoborockLocalTransport
    this.localCooldownUntil = new Map(); // duid -> timestamp
    this.lastTransport = new Map(); // duid -> 'local' | 'cloud'
  }

  isLoggedIn() {
    // The session alone decides. Requiring a robot as well made an account with
    // a valid session but no robot look unlinked — verified on a real account
    // whose robots are all paired in the Xiaomi Home app: the link succeeded, the
    // session was stored, and the screen still showed nothing as connected.
    return this.rest.isLoggedIn();
  }

  /**
   * Whether a silent (interaction-free) login is possible.
   * @returns {boolean} true when a stored token is available
   */
  canLoginSilently() {
    return this.rest.isLoggedIn();
  }

  /**
   * The session worth persisting.
   * @returns {object} the session
   */
  getSession() {
    return this.rest.getSession();
  }

  // --- Linking the account ----------------------------------------------------

  /**
   * Link the account with its password, then load the robots. This is the whole
   * link: it needs no interaction, so saving the credentials is enough and there
   * is nothing else for the user to do.
   *
   * A Roborock account often has NO password: registering with a verification
   * code — the default path in the app — creates none, and neither does signing
   * in through Google or Apple. Roborock then answers exactly the same
   * `2012 username or password error` as for a wrong password, so the two are
   * indistinguishable from here. The typed code lets the caller say so in the
   * user's own language.
   * @param {string} username the account email
   * @param {string} password the account password
   */
  async linkWithPassword(username, password) {
    try {
      await this.rest.loginWithPassword(username, password);
    } catch (err) {
      if (err.code === BAD_CREDENTIALS_CODE) {
        const refused = new Error('Roborock refused these credentials (error 2012)', {
          cause: err,
        });
        refused.reason = CREDENTIALS_REFUSED;
        throw refused;
      }
      if (err.code === TWO_STEP_CODE) {
        // The password was accepted: Roborock now wants the code it sends to the
        // account owner. Nothing here can clear that — only the user can.
        const twoStep = new Error('Roborock requires a two-step validation (error 2031)', {
          cause: err,
        });
        twoStep.reason = TWO_STEP_REQUIRED;
        throw twoStep;
      }
      throw err;
    }
    await this.#loadDevices();
  }

  /**
   * Ask Roborock to email a one-time login code. Kept for the accounts that have
   * no password (Google/Apple sign-in), but not wired to the UI.
   * @param {string} username the account email
   */
  async requestEmailCode(username) {
    await this.rest.requestEmailCode(username);
  }

  /**
   * Finish a link with the code received by email, then load the robots.
   * @param {string} username the account email
   * @param {string} code the code received by email
   */
  async linkWithEmailCode(username, code) {
    try {
      await this.rest.loginWithEmailCode(username, code);
    } catch (err) {
      if (err.code === EMAIL_CODE_ERROR || err.code === BAD_CREDENTIALS_CODE) {
        // a code is single-use and short-lived, so this is nearly always an
        // expired or already-used one rather than a typo
        const refused = new Error(`Roborock refused this code (error ${err.code})`, { cause: err });
        refused.reason = CODE_REFUSED;
        throw refused;
      }
      throw err;
    }
    await this.#loadDevices();
  }

  // --- Silent login (every restart) ------------------------------------------

  /**
   * Reconnect with the stored token and load the robots.
   */
  async login() {
    if (!this.canLoginSilently()) {
      throw new Error('Roborock account not linked yet: fill in your credentials first');
    }
    await this.#loadDevices();
    logger.info('Roborock session restored (no interaction)');
  }

  /**
   * Load the account robots (with their local key and IP) and connect the cloud
   * transport.
   */
  async #loadDevices() {
    const homeId = await this.rest.getHomeId();
    const homeData = await this.rest.getHomeData(homeId);

    const products = new Map((homeData.products || []).map((product) => [product.id, product]));
    const rawDevices = [...(homeData.devices || []), ...(homeData.receivedDevices || [])].filter(
      (device) => isVacuum(device, products),
    );

    this.devices = rawDevices.map((device) => {
      const product = products.get(device.productId) || {};
      return {
        duid: String(device.duid),
        name: device.name || String(device.duid),
        model: product.model || null,
        online: device.online !== false,
        routines: [],
      };
    });

    await Promise.all(
      this.devices.map(async (device) => {
        try {
          device.routines = await this.rest.getScenes(device.duid);
        } catch (err) {
          // Routine support varies by model/account. It must never prevent the
          // robot itself from being discovered and controlled.
          logger.warn(`Could not load routines for ${device.duid}: ${err.message}`);
        }
      }),
    );
    this.localKeys = new Map();
    this.localIps = new Map();
    rawDevices.forEach((device) => {
      if (device.localKey) {
        this.localKeys.set(String(device.duid), device.localKey);
      }
    });
    logger.info(`${this.devices.length} Roborock robot(s) loaded`);

    if (this.mqtt) {
      await this.mqtt.disconnect();
    }
    this.mqtt = new RoborockMqttTransport(this.rest.rriot, this.localKeys);
    await this.mqtt.connect();
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
   * @param {string} method the Roborock method
   * @param {Array|object} [params] the method params
   * @returns {Promise<*>} the RPC result
   */
  async sendCommand(duid, method, params = []) {
    return this.#execute(duid, method, params);
  }

  /**
   * Execute one of the account routines. Unlike robot RPC commands, routines
   * are cloud-side scenes and therefore always use the Roborock REST API.
   * @param {number} routineId the routine/scene id
   */
  async executeRoutine(routineId) {
    await this.rest.executeScene(routineId);
  }

  /**
   * The transport used for the last RPC of a device.
   * @param {string} duid the device id
   * @returns {string|null} 'local', 'cloud', or null
   */
  getLastTransport(duid) {
    return this.lastTransport.get(duid) || null;
  }

  async #execute(duid, method, params) {
    const local = await this.#getLocalTransport(duid);
    if (local) {
      try {
        const result = await local.request(method, params);
        this.lastTransport.set(duid, 'local');
        return result;
      } catch (e) {
        logger.warn(`Local request failed for ${duid}, falling back to cloud: ${e.message}`);
        this.#coolDownLocal(duid);
      }
    }
    const result = await this.mqtt.request(duid, method, params);
    this.lastTransport.set(duid, 'cloud');
    return result;
  }

  async #getLocalTransport(duid) {
    if (Date.now() < (this.localCooldownUntil.get(duid) || 0)) {
      return null;
    }
    if (this.localTransports.has(duid)) {
      return this.localTransports.get(duid);
    }
    const ip = await this.#discoverLocalIp(duid);
    if (!ip) {
      this.#coolDownLocal(duid);
      return null;
    }
    const transport = new RoborockLocalTransport(duid, ip, this.localKeys.get(duid));
    this.localTransports.set(duid, transport);
    return transport;
  }

  /**
   * Discover a robot's LAN IP through the cloud `get_network_info` command.
   * @param {string} duid the device id
   * @returns {Promise<string|null>} the IP, or null if unknown
   */
  async #discoverLocalIp(duid) {
    if (this.localIps.has(duid)) {
      return this.localIps.get(duid);
    }
    try {
      const info = await this.mqtt.request(duid, 'get_network_info', []);
      const ip = info && (info.ip || (Array.isArray(info) && info[0] && info[0].ip));
      if (ip) {
        this.localIps.set(duid, ip);
        logger.debug(`Local IP of ${duid} is ${ip}`);
        return ip;
      }
    } catch (e) {
      logger.debug(`Could not discover the local IP of ${duid}: ${e.message}`);
    }
    return null;
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
    if (this.mqtt) {
      await this.mqtt.disconnect();
      this.mqtt = null;
    }
    this.rest.logout();
    this.devices = [];
    this.localKeys = new Map();
  }
}
