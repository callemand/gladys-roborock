// -----------------------------------------------------------------------------
// Persisted Xiaomi session.
//
// The whole point: an integration runs unattended in a container, but Xiaomi
// protects password logins with a captcha / "verify it's you" step that only a
// human in front of a browser can clear. So the interactive login happens ONCE,
// and the long-lived credentials it yields are persisted through the Gladys
// config (`gladys.setConfig()`, off-schema keys). Every later start reuses them
// and never needs the password again.
//
// The stored keys are deliberately off-schema (not in `config_schema`): they are
// integration-managed state, never shown as a form field.
// -----------------------------------------------------------------------------

// Off-schema config keys holding the session.
export const SESSION_KEYS = {
  DEVICE_ID: 'session_device_id',
  USER_ID: 'session_user_id',
  PASS_TOKEN: 'session_pass_token',
  SSECURITY: 'session_ssecurity',
  REGION: 'session_region',
};

/**
 * Read the persisted session from a raw Gladys config object.
 * @param {Record<string, unknown>} raw the config returned by gladys.getConfig()
 * @returns {{ deviceId: string|null, userId: string|null, passToken: string|null,
 *   ssecurity: string|null, region: string|null }} the session
 */
export function readSession(raw = {}) {
  return {
    deviceId: str(raw[SESSION_KEYS.DEVICE_ID]),
    userId: str(raw[SESSION_KEYS.USER_ID]),
    passToken: str(raw[SESSION_KEYS.PASS_TOKEN]),
    ssecurity: str(raw[SESSION_KEYS.SSECURITY]),
    region: str(raw[SESSION_KEYS.REGION]),
  };
}

/**
 * Whether a session carries enough to re-authenticate without the password.
 * @param {object} session a session from readSession()
 * @returns {boolean} true when reusable
 */
export function isSessionUsable(session) {
  return Boolean(session && session.userId && session.passToken);
}

/**
 * Build the config payload persisting a session.
 * @param {object} session the session to store
 * @returns {Record<string, string>} the payload for gladys.setConfig()
 */
export function sessionToConfig(session) {
  return {
    [SESSION_KEYS.DEVICE_ID]: session.deviceId || '',
    [SESSION_KEYS.USER_ID]: session.userId || '',
    [SESSION_KEYS.PASS_TOKEN]: session.passToken || '',
    [SESSION_KEYS.SSECURITY]: session.ssecurity || '',
    [SESSION_KEYS.REGION]: session.region || '',
  };
}

/**
 * The config payload clearing a stored session (logout / failed reuse).
 * @returns {Record<string, string>} the payload for gladys.setConfig()
 */
export function clearedSessionConfig() {
  return sessionToConfig({});
}

/**
 * Coerce a config value to a non-empty string, or null.
 * @param {unknown} value the raw value
 * @returns {string|null} the string, or null
 */
function str(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}
