// -----------------------------------------------------------------------------
// Persisted Roborock session.
//
// The whole point: an integration runs unattended in a container, but linking a
// Roborock account needs a code only its owner can read, in their mailbox. So the
// account is linked ONCE, and the long-lived credentials it yields (the account
// token and the `rriot` credentials) are persisted through the Gladys config
// (`gladys.setConfig()`, off-schema keys). Every later start reuses them, with no
// interaction.
//
// The stored keys are deliberately off-schema (not in `config_schema`): they are
// integration-managed state, never rendered as a form field.
// -----------------------------------------------------------------------------

// Off-schema config keys holding the session.
export const SESSION_KEYS = {
  // A client identifier that must stay stable across restarts: it identifies
  // this client to the account.
  DEVICE_ID: 'session_roborock_device_id',
  USERNAME: 'session_roborock_username',
  TOKEN: 'session_roborock_token',
  RRIOT: 'session_roborock_rriot',
  BASE_URL: 'session_roborock_base_url',
};

/**
 * Read the persisted session from a raw Gladys config object.
 * @param {Record<string, unknown>} raw the config returned by gladys.getConfig()
 * @returns {object} the session (absent fields are null)
 */
export function readSession(raw = {}) {
  return {
    deviceId: str(raw[SESSION_KEYS.DEVICE_ID]),
    username: str(raw[SESSION_KEYS.USERNAME]),
    token: str(raw[SESSION_KEYS.TOKEN]),
    rriot: json(raw[SESSION_KEYS.RRIOT]),
    baseUrl: str(raw[SESSION_KEYS.BASE_URL]),
  };
}

/**
 * Whether a session carries enough to re-authenticate without any interaction.
 * @param {object} session a session from readSession()
 * @returns {boolean} true when reusable
 */
export function isSessionUsable(session) {
  return Boolean(session && session.token && session.rriot);
}

/**
 * Build the config payload persisting a session.
 * @param {object} session the session to store
 * @returns {Record<string, string>} the payload for gladys.setConfig()
 */
export function sessionToConfig(session = {}) {
  return {
    [SESSION_KEYS.DEVICE_ID]: session.deviceId || '',
    [SESSION_KEYS.USERNAME]: session.username || '',
    [SESSION_KEYS.TOKEN]: session.token || '',
    [SESSION_KEYS.RRIOT]: session.rriot ? JSON.stringify(session.rriot) : '',
    [SESSION_KEYS.BASE_URL]: session.baseUrl || '',
  };
}

/**
 * The config payload clearing the stored session (the account was unlinked, or
 * the cloud no longer accepts it).
 * @returns {Record<string, string>} the payload for gladys.setConfig()
 */
export function clearedSessionConfig() {
  return sessionToConfig({});
}

/**
 * Whether two sessions carry the same credentials. Used to tell OUR OWN config
 * write apart from a real change, which would otherwise loop
 * (persist -> config-updated -> reconnect -> persist).
 * @param {object} a first session
 * @param {object} b second session
 * @returns {boolean} true when equivalent
 */
export function sameSession(a, b) {
  if (!a || !b) {
    return false;
  }
  return (
    (a.deviceId || null) === (b.deviceId || null) &&
    (a.username || null) === (b.username || null) &&
    (a.token || null) === (b.token || null) &&
    (a.baseUrl || null) === (b.baseUrl || null) &&
    // compared by value: it comes back parsed from JSON, never the same object
    JSON.stringify(a.rriot || null) === JSON.stringify(b.rriot || null)
  );
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

/**
 * Parse a JSON-encoded config value (the rriot credentials are an object).
 * @param {unknown} value the raw value
 * @returns {object|null} the parsed object, or null
 */
function json(value) {
  const text = str(value);
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
