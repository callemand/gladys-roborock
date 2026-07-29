// -----------------------------------------------------------------------------
// Xiaomi Mi Home cloud client (uses the Node.js built-in fetch).
//
// Authentication — the whole design exists to work UNATTENDED in a container:
//
//   1. FIRST TIME (interactive, once): QR login. The user opens a link / scans a
//      QR with the Xiaomi Home app and confirms. Xiaomi returns a long-lived
//      `passToken`. This path has NO password, NO captcha and NO 2FA — unlike
//      the password login, which Xiaomi gates behind a captcha and an
//      identity-verification step that a headless container cannot clear.
//   2. EVERY LATER START (silent): GET /pass/serviceLogin with the persisted
//      `userId` + `passToken` + `deviceId` cookies returns a fresh `ssecurity`
//      and `location` with no interaction at all.
//
// The `deviceId` MUST stay stable across restarts: it carries the device trust
// that keeps Xiaomi from re-triggering a verification.
//
// Two hard-won details, both verified against the live API:
//   - `nonce` is a LONG integer: JSON.parse loses precision on it, which
//     silently breaks the clientSign and yields no serviceToken. It is read as
//     a raw string from the response text instead.
//   - the serviceToken only comes back when `location` is called WITH a valid
//     `clientSign` derived from that exact nonce.
//
// API calls (device_list, home/rpc/{did}) are RC4-encrypted and SHA1-signed
// with the ssecurity secret (see src/xiaomi/miCrypto.js).
// -----------------------------------------------------------------------------

import crypto from 'node:crypto';

import { createLogger } from '@gladysassistant/integration-sdk';

import { XIAOMI_ACCOUNT_HOST } from '../constants.js';
import { buildEncParams, decryptResponse, generateNonce } from './miCrypto.js';

const logger = createLogger({ name: 'xiaomi:cloud' });

const REQUEST_TIMEOUT_MS = 15000;
// One long-poll leg: the endpoint holds the connection open until the user acts.
const LONG_POLL_TIMEOUT_MS = 35000;
const START_PREFIX = '&&&START&&&';

/**
 * Generate a stable device identifier (16 uppercase alphanumeric chars).
 * @returns {string} the device id
 */
export function generateDeviceId() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let out = '';
  for (let i = 0; i < 16; i += 1) {
    out += alphabet[crypto.randomInt(alphabet.length)];
  }
  return out;
}

/**
 * The Mi Home API base URL for a region ('cn'/'' -> no prefix).
 * @param {string} region the region code
 * @returns {string} the API base URL
 */
export function apiBaseUrl(region) {
  // The env var override is only used by the test suite (fake API server).
  if (process.env.XIAOMI_API_BASE) {
    return process.env.XIAOMI_API_BASE.replace(/\/+$/, '');
  }
  const code = (region || '').toLowerCase();
  const prefix = code === '' || code === 'cn' ? '' : `${code}.`;
  return `https://${prefix}api.io.mi.com/app`;
}

/**
 * Parse a Xiaomi response body that is prefixed with `&&&START&&&`.
 * @param {string} text the raw response text
 * @returns {object} the parsed JSON
 */
function parseXiaomiJson(text) {
  return JSON.parse(text.startsWith(START_PREFIX) ? text.slice(START_PREFIX.length) : text);
}

/**
 * Read `nonce` as a raw string from a response body.
 *
 * The login nonce is a 19-digit integer, beyond Number.MAX_SAFE_INTEGER:
 * JSON.parse silently rounds it (e.g. ...751168 -> ...751000), the clientSign
 * computed from it is wrong, and Xiaomi answers "ok" WITHOUT setting the
 * serviceToken cookie. Reading it from the raw text preserves every digit.
 * @param {string} text the raw response text
 * @param {object} parsed the same body already parsed (fallback)
 * @returns {string|null} the nonce, digits intact
 */
function readNonce(text, parsed) {
  const match = text.match(/"nonce"\s*:\s*(-?\d+)/);
  if (match) {
    return match[1];
  }
  return parsed && parsed.nonce !== undefined ? String(parsed.nonce) : null;
}

export class MiCloudClient {
  /**
   * @param {string} region the Xiaomi region code (e.g. 'de', 'us', 'cn')
   * @param {object} [session] a persisted session ({ deviceId, userId, passToken })
   */
  constructor(region = 'de', session = {}) {
    this.region = region;
    this.userAgent =
      'Android-7.1.1-1.0.0-ONEPLUS A3010-136-AABBCCDDEEFFA APP/xiaomi.smarthome APPV/62830';
    this.deviceId = session.deviceId || generateDeviceId();
    this.userId = session.userId || null;
    this.passToken = session.passToken || null;
    this.ssecurity = null;
    this.serviceToken = null;
    this.cookies = new Map();
    this.qrLogin = null; // { lp, loginUrl, qr, expiresAt }
    this.#resetCookies();
  }

  isLoggedIn() {
    return this.ssecurity !== null && this.serviceToken !== null;
  }

  /**
   * Whether a silent (password-less) login is possible.
   * @returns {boolean} true when a passToken is available
   */
  canLoginSilently() {
    return Boolean(this.userId && this.passToken);
  }

  /**
   * The credentials worth persisting (see src/xiaomi/session.js).
   * @returns {object} the session
   */
  getSession() {
    return {
      deviceId: this.deviceId,
      userId: this.userId,
      passToken: this.passToken,
      ssecurity: this.ssecurity,
      region: this.region,
    };
  }

  logout() {
    this.ssecurity = null;
    this.serviceToken = null;
    this.qrLogin = null;
    this.#resetCookies();
  }

  #resetCookies() {
    this.cookies = new Map([
      ['sdkVersion', '3.9'],
      ['deviceId', this.deviceId],
    ]);
    if (this.userId) {
      this.cookies.set('userId', String(this.userId));
    }
    if (this.passToken) {
      this.cookies.set('passToken', this.passToken);
    }
  }

  #cookieHeader(extra = {}) {
    const all = new Map(this.cookies);
    for (const [k, v] of Object.entries(extra)) {
      all.set(k, v);
    }
    return [...all.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  #storeCookies(response) {
    const setCookies =
      typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    for (const line of setCookies) {
      const [pair] = line.split(';');
      const idx = pair.indexOf('=');
      if (idx > 0) {
        const name = pair.slice(0, idx).trim();
        const value = pair.slice(idx + 1).trim();
        if (value && value !== 'EXPIRED') {
          this.cookies.set(name, value);
        }
      }
    }
  }

  // --- QR login (interactive, once) -----------------------------------------

  /**
   * Start a QR login: ask Xiaomi for a login URL + QR image, to be opened /
   * scanned by the user. Call pollQrLogin() afterwards to await the approval.
   * @returns {Promise<{ loginUrl: string, qrUrl: string, expiresIn: number }>} the login prompt
   */
  async startQrLogin() {
    this.#resetCookies();
    const query = new URLSearchParams({
      _qrsize: '480',
      qs: '%3Fsid%3Dxiaomiio%26_json%3Dtrue',
      callback: 'https://sts.api.io.mi.com/sts',
      _hasLogo: 'false',
      sid: 'xiaomiio',
      serviceParam: '',
      _locale: 'en_US',
      _dc: String(Date.now()),
    });
    const response = await fetch(`${XIAOMI_ACCOUNT_HOST}/longPolling/loginUrl?${query}`, {
      method: 'GET',
      headers: { 'User-Agent': this.userAgent, Cookie: this.#cookieHeader() },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    this.#storeCookies(response);
    const data = parseXiaomiJson(await response.text());
    if (!data || !data.lp || !data.loginUrl) {
      throw new Error('Xiaomi QR login could not be started');
    }
    const expiresIn = Number(data.timeout) || 300;
    this.qrLogin = {
      lp: data.lp,
      loginUrl: data.loginUrl,
      qr: data.qr,
      expiresAt: Date.now() + expiresIn * 1000,
    };
    logger.info('QR login started, waiting for the user to approve it');
    return { loginUrl: data.loginUrl, qrUrl: data.qr, expiresIn };
  }

  /**
   * Whether a QR login is pending (started and not expired).
   * @returns {boolean} true while the prompt is valid
   */
  hasPendingQrLogin() {
    return Boolean(this.qrLogin && Date.now() < this.qrLogin.expiresAt);
  }

  /**
   * Await the QR approval (one long-poll leg). Returns true once approved (the
   * session is then complete), false while still pending.
   * @returns {Promise<boolean>} whether the login completed
   */
  async pollQrLogin() {
    if (!this.qrLogin) {
      throw new Error('No QR login in progress');
    }
    if (Date.now() >= this.qrLogin.expiresAt) {
      this.qrLogin = null;
      throw new Error('The QR login expired, start a new one');
    }
    let text;
    try {
      const response = await fetch(this.qrLogin.lp, {
        method: 'GET',
        headers: { 'User-Agent': this.userAgent, Cookie: this.#cookieHeader() },
        signal: AbortSignal.timeout(LONG_POLL_TIMEOUT_MS),
      });
      this.#storeCookies(response);
      text = await response.text();
    } catch {
      return false; // the long poll timed out: nobody scanned yet
    }
    const data = parseXiaomiJson(text);
    if (!data || !data.passToken) {
      return false;
    }
    this.userId = String(data.userId);
    this.passToken = data.passToken;
    this.ssecurity = data.ssecurity;
    this.#resetCookies();
    await this.#exchangeLocation(data.location, readNonce(text, data));
    this.qrLogin = null;
    logger.info('QR login approved, session established');
    return true;
  }

  // --- Silent login (every restart) -----------------------------------------

  /**
   * Log in with the persisted passToken, without any user interaction.
   * @returns {Promise<void>} resolves once the session is established
   */
  async loginWithPassToken() {
    if (!this.canLoginSilently()) {
      throw new Error('No Xiaomi passToken stored: connect the account first');
    }
    this.#resetCookies();
    const response = await fetch(
      `${XIAOMI_ACCOUNT_HOST}/pass/serviceLogin?sid=xiaomiio&_json=true`,
      {
        method: 'GET',
        headers: { 'User-Agent': this.userAgent, Cookie: this.#cookieHeader() },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    this.#storeCookies(response);
    const text = await response.text();
    const data = parseXiaomiJson(text);
    if (data.code !== 0 || !data.ssecurity || !data.location) {
      throw new Error(
        'The stored Xiaomi session is no longer valid: reconnect the account (scan the QR again)',
      );
    }
    this.ssecurity = data.ssecurity;
    if (data.passToken) {
      this.passToken = data.passToken; // Xiaomi rotates it
    }
    if (data.userId) {
      this.userId = String(data.userId);
    }
    this.#resetCookies();
    await this.#exchangeLocation(data.location, readNonce(text, data));
    logger.info('Xiaomi session restored silently (no interaction)');
  }

  /**
   * Exchange the login `location` for the serviceToken cookie.
   * @param {string} location the location URL returned by the login
   * @param {string|null} nonce the login nonce, as a raw string
   */
  async #exchangeLocation(location, nonce) {
    if (!location) {
      throw new Error('Xiaomi login returned no location');
    }
    let url = location;
    if (nonce && this.ssecurity) {
      // Verified: without a clientSign built from the EXACT nonce, Xiaomi
      // answers "ok" and never sets the serviceToken cookie.
      const clientSign = crypto
        .createHash('sha1')
        .update(`nonce=${nonce}&${this.ssecurity}`)
        .digest('base64');
      url += `${url.includes('?') ? '&' : '?'}clientSign=${encodeURIComponent(clientSign)}`;
    }
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': this.userAgent,
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: this.#cookieHeader(),
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    this.#storeCookies(response);
    this.serviceToken = this.cookies.get('serviceToken') || null;
    if (!this.serviceToken) {
      throw new Error('Xiaomi login failed: no serviceToken returned');
    }
  }

  // --- Signed API calls ------------------------------------------------------

  /**
   * Perform a signed + RC4-encrypted Mi Home API call.
   * @param {string} path the API path (e.g. '/home/device_list')
   * @param {object} data the request data object
   * @returns {Promise<object>} the parsed JSON response
   */
  async request(path, data) {
    if (!this.isLoggedIn()) {
      throw new Error('Xiaomi cloud is not connected');
    }
    const url = `${apiBaseUrl(this.region)}${path}`;
    const nonce = generateNonce();
    const form = buildEncParams(url, 'POST', this.ssecurity, nonce, { data: JSON.stringify(data) });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'User-Agent': this.userAgent,
        'Accept-Encoding': 'identity',
        'x-xiaomi-protocal-flag-cli': 'PROTOCAL-HTTP2',
        'Content-Type': 'application/x-www-form-urlencoded',
        'MIOT-ENCRYPT-ALGORITHM': 'ENCRYPT-RC4',
        Cookie: this.#apiCookieHeader(),
      },
      body: new URLSearchParams(form),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Xiaomi API ${path} -> HTTP ${response.status}`);
    }
    return JSON.parse(decryptResponse(this.ssecurity, nonce, await response.text()));
  }

  #apiCookieHeader() {
    const tzOffsetMin = -new Date().getTimezoneOffset();
    const sign = tzOffsetMin >= 0 ? '+' : '-';
    const abs = Math.abs(tzOffsetMin);
    const timezone = `GMT${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
    return this.#cookieHeader({
      userId: String(this.userId),
      serviceToken: this.serviceToken,
      yetAnotherServiceToken: this.serviceToken,
      locale: 'en_US',
      timezone,
      is_daylight: '0',
      dst_offset: '0',
      channel: 'MI_APP_STORE',
    });
  }

  /**
   * Fetch the account devices.
   * @returns {Promise<Array>} the device list (result.list)
   */
  async getDevices() {
    const response = await this.request('/home/device_list', {
      getVirtualModel: true,
      getHuamiDevices: 1,
      get_split_device: false,
      support_smart_home: true,
    });
    return (response.result && response.result.list) || [];
  }

  /**
   * Send an RPC to a device over the cloud.
   * @param {string} did the device id
   * @param {object} rpc the RPC ({ id, method, params })
   * @returns {Promise<*>} the RPC result
   */
  async rpc(did, rpc) {
    const response = await this.request(`/home/rpc/${did}`, rpc);
    if (response.error) {
      throw new Error(`miIO cloud error: ${JSON.stringify(response.error)}`);
    }
    return response.result;
  }
}
