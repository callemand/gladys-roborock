// -----------------------------------------------------------------------------
// Roborock cloud REST client (Node.js built-in fetch).
//
// Auth flow (mirror of python-roborock's web_api.py):
//   1. login  -> UserData { token, rriot { u, s, h, k, r { a, m } } }
//   2. GET /api/v1/getHomeDetail            -> the home id (rrHomeId)
//   3. GET {rriot.r.a}/v3/user/homes/{id}   -> devices (with localKey) + products
//
// Two deliberate choices, both from what the live API actually does:
//
//   - The region is found by ATTEMPTING THE LOGIN on each candidate host. The
//     documented `getUrlByEmail` lookup is deprecated: it answers 200 echoing
//     whichever host you queried, with `country: null`, so it cannot resolve
//     anything (verified against the live API).
//   - The login is done by EMAIL CODE, never by password. Many accounts have no
//     password at all (registered with a code, or through Google/Apple), and
//     those that do may be guarded by two-step validation, where the password is
//     accepted and then refused for want of a second factor (`2031 need
//     two-step validate`, seen on a live account). The code login covers every
//     case, so it is the only one wired. `loginWithPassword` is kept for
//     completeness.
//
// The account endpoints use the raw `token` as Authorization; the IoT API
// (rriot.r.a) uses a per-request Hawk signature.
// -----------------------------------------------------------------------------

import crypto from 'node:crypto';

import { createLogger } from '@gladysassistant/integration-sdk';

import { ROBOROCK_BASE_URLS } from '../constants.js';
import { md5, md5hex } from './crypto.js';

const logger = createLogger({ name: 'roborock:rest' });

const REQUEST_TIMEOUT_MS = 15000;
// Codes that mean "this region does not host that account", so the next one is
// worth trying: `username or password error` from the password endpoint, and
// `user not exist` from the code one. Verified against the live API on an
// account hosted in eu: us answers 2008 to a code login and 2012 to a password
// one, while eu answers 2031. Anything NOT in this set is a real answer from the
// region that does host the account, and must stop the search.
const ERROR_CODE_BAD_CREDENTIALS = 2012;
const ERROR_CODE_USER_NOT_FOUND = 2008;
const REGION_MISMATCH_CODES = new Set([ERROR_CODE_BAD_CREDENTIALS, ERROR_CODE_USER_NOT_FOUND]);

export class RoborockRestClient {
  /**
   * @param {object} [session] a persisted session ({ deviceId, token, rriot, baseUrl })
   */
  constructor(session = {}) {
    this.baseUrls = ROBOROCK_BASE_URLS;
    // Kept stable across restarts (persisted with the session): it identifies
    // this client to the account.
    this.deviceId = session.deviceId || crypto.randomBytes(16).toString('base64url');
    this.token = session.token || null;
    this.rriot = session.rriot || null;
    this.baseUrl = session.baseUrl || null;
    this.username = session.username || null;
  }

  isLoggedIn() {
    return Boolean(this.token && this.rriot);
  }

  logout() {
    this.token = null;
    this.rriot = null;
  }

  /**
   * The credentials worth persisting.
   * @returns {object} the session
   */
  getSession() {
    return {
      deviceId: this.deviceId,
      username: this.username,
      token: this.token,
      rriot: this.rriot,
      baseUrl: this.baseUrl,
    };
  }

  /**
   * The base64(md5(username + deviceId)) client id sent on the account endpoints.
   * @param {string} username the account email
   * @returns {string} the header value
   */
  #headerClientId(username) {
    return md5(Buffer.concat([Buffer.from(username), Buffer.from(this.deviceId)])).toString(
      'base64',
    );
  }

  /**
   * Ask Roborock to email a one-time login code.
   *
   * Verified against the live API: the eu region accepted it and delivered the
   * code to the account owner.
   * @param {string} username the account email
   * @returns {Promise<void>} resolves once the code has been requested
   */
  async requestEmailCode(username) {
    this.username = username;
    let lastError;
    for (const baseUrl of this.baseUrls) {
      try {
        const query = new URLSearchParams({ username, type: 'auth' });
        await this.#fetchJson(`${baseUrl}/api/v1/sendEmailCode?${query}`, {
          method: 'POST',
          headers: { header_clientid: this.#headerClientId(username) },
        });
        this.baseUrl = baseUrl;
        logger.info(`Login code requested for ${username} (${baseUrl})`);
        return;
      } catch (e) {
        lastError = e;
        logger.debug(`sendEmailCode failed on ${baseUrl}: ${e.message}`);
      }
    }
    throw lastError || new Error('Could not request a Roborock login code');
  }

  /**
   * Log in with the code received by email.
   * @param {string} username the account email
   * @param {string} code the code received by email
   * @returns {Promise<object>} the session
   */
  async loginWithEmailCode(username, code) {
    return this.#loginAcrossRegions(username, (baseUrl) => {
      const query = new URLSearchParams({
        username,
        verifycode: code,
        verifycodetype: 'AUTH_EMAIL_CODE',
      });
      return `${baseUrl}/api/v1/loginWithCode?${query}`;
    });
  }

  /**
   * Log in with the account password (only works when the account actually has
   * one: accounts created through Google/Apple do not).
   * @param {string} username the account email
   * @param {string} password the account password
   * @returns {Promise<object>} the session
   */
  async loginWithPassword(username, password) {
    return this.#loginAcrossRegions(username, (baseUrl) => {
      const query = new URLSearchParams({ username, password, needtwostepauth: 'false' });
      return `${baseUrl}/api/v1/login?${query}`;
    });
  }

  /**
   * Try a login URL on each region until one returns a usable UserData.
   * @param {string} username the account email
   * @param {Function} buildUrl builds the login URL for a base URL
   * @returns {Promise<object>} the session
   */
  async #loginAcrossRegions(username, buildUrl) {
    this.logout();
    this.username = username;
    // The region remembered from a previous login goes first.
    const candidates = this.baseUrl
      ? [this.baseUrl, ...this.baseUrls.filter((url) => url !== this.baseUrl)]
      : this.baseUrls;

    let lastError;
    for (const baseUrl of candidates) {
      try {
        const data = await this.#fetchJson(buildUrl(baseUrl), {
          method: 'POST',
          headers: { header_clientid: this.#headerClientId(username) },
        });
        if (data && data.token && data.rriot) {
          this.token = data.token;
          this.rriot = data.rriot;
          this.baseUrl = baseUrl;
          logger.info(`Logged in to the Roborock cloud (${baseUrl})`);
          return this.getSession();
        }
        lastError = new Error(`Roborock returned no session on ${baseUrl}`);
      } catch (e) {
        lastError = e;
        // A region-mismatch code says nothing: try the next region. ANY other
        // answer comes from the region that hosts the account — even a refusal,
        // like "need two-step validate" — so stop and surface that one.
        //
        // Learned the hard way, twice. First the loop kept going past eu's 2031
        // and let ru's 2012 overwrite it, telling the user their password was
        // wrong when it was right. Then it stopped at us's 2008 "user not exist"
        // and never reached eu at all.
        if (!REGION_MISMATCH_CODES.has(e.code)) {
          this.baseUrl = baseUrl;
          throw e;
        }
        logger.debug(`Login on ${baseUrl} failed: ${e.message}`);
      }
    }
    // No region knows that account. Carry the code so the caller can phrase it
    // for the user — the advice belongs to the UI layer, not here.
    const refused = new Error(
      `Roborock API error ${ERROR_CODE_BAD_CREDENTIALS}: no region knows this account`,
      { cause: lastError },
    );
    refused.code = ERROR_CODE_BAD_CREDENTIALS;
    throw refused;
  }

  /**
   * Fetch the account home id.
   * @returns {Promise<number>} the home id
   */
  async getHomeId() {
    this.#assertLoggedIn();
    const data = await this.#fetchJson(`${this.baseUrl}/api/v1/getHomeDetail`, {
      method: 'GET',
      headers: {
        header_clientid: this.#headerClientId(this.username || ''),
        Authorization: this.token,
      },
    });
    if (!data || data.rrHomeId === undefined) {
      throw new Error('Roborock getHomeDetail failed: no home id returned');
    }
    return data.rrHomeId;
  }

  /**
   * Fetch the full HomeData (devices + products) from the IoT API.
   * @param {number} homeId the account home id
   * @returns {Promise<object>} the HomeData
   */
  async getHomeData(homeId) {
    this.#assertLoggedIn();
    const response = await this.#hawkRequest(`/v3/user/homes/${homeId}`);
    return response.result || response;
  }

  /**
   * Perform a GET on the IoT API, signed with a Hawk authorization header.
   * @param {string} path the request path
   * @returns {Promise<object>} the parsed JSON response
   */
  async #hawkRequest(path) {
    const { rriot } = this;
    const apiBase = rriot.r.a.replace(/\/+$/, '');
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomBytes(6).toString('base64url');
    // params and payload are empty for a plain GET: the two trailing colons of
    // the signed string matter.
    const prestr = `${rriot.u}:${rriot.s}:${nonce}:${timestamp}:${md5hex(path)}::`;
    const mac = crypto.createHmac('sha256', rriot.h).update(prestr).digest('base64');
    const authorization = `Hawk id="${rriot.u}",s="${rriot.s}",ts="${timestamp}",nonce="${nonce}",mac="${mac}"`;
    return this.#fetchJson(`${apiBase}${path}`, {
      method: 'GET',
      headers: { Authorization: authorization },
    });
  }

  #assertLoggedIn() {
    if (!this.isLoggedIn()) {
      throw new Error('Roborock cloud is not connected');
    }
  }

  async #fetchJson(url, { method = 'GET', headers = {} }) {
    const response = await fetch(url, {
      method,
      headers: { Accept: 'application/json', ...headers },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      const error = new Error(`Roborock request failed: ${method} -> HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const text = await response.text();
    const body = text ? JSON.parse(text) : {};
    // The account endpoints wrap the payload in { code, msg, data }. A `code`
    // alone is enough to tell a failure: requiring `data` too would swallow any
    // error answered without it, turning a precise "credentials refused" into a
    // generic "login failed" with nothing for the user to act on.
    if (body && typeof body === 'object' && 'code' in body) {
      if (body.code !== 200 && body.code !== 0) {
        const error = new Error(`Roborock API error ${body.code}: ${body.msg || 'unknown error'}`);
        error.code = body.code;
        throw error;
      }
      if ('data' in body) {
        return body.data;
      }
    }
    return body;
  }
}
