// -----------------------------------------------------------------------------
// Roborock protocol constants + the few Gladys values the SDK does not export.
//
// The standard Gladys feature categories / types / units come straight from
// the SDK (DEVICE_FEATURE_CATEGORIES, DEVICE_FEATURE_TYPES,
// DEVICE_FEATURE_UNITS) — only integration-specific values live here.
//
// The Roborock enums below are the values reverse-engineered by the
// python-roborock library (used by the Home Assistant Roborock integration).
// They MUST be verified against a real device when possible: some fan-power
// codes differ across model generations (see FAN_POWER_TO_CLEAN_MODE).
// -----------------------------------------------------------------------------

// --- Gladys enums (mirror of server/utils/constants.js) ----------------------

// Operational state of the vacuum (vacuum-cleaner / state feature).
export const VACUUM_CLEANER_STATE = {
  STOPPED: 0,
  RUNNING: 1,
  PAUSED: 2,
  ERROR: 3,
  RETURNING_TO_DOCK: 4,
  CHARGING: 5,
  DOCKED: 6,
};

// Run mode of the vacuum (vacuum-cleaner / run-mode feature).
export const VACUUM_CLEANER_MODE = {
  IDLE: 0,
  CLEANING: 1,
  MAPPING: 2,
};

// Clean mode of the vacuum (vacuum-cleaner / clean-mode feature).
export const VACUUM_CLEANER_CLEAN_MODE = {
  AUTO: 0,
  QUICK: 1,
  QUIET: 2,
  LOW_NOISE: 3,
  DEEP_CLEAN: 4,
  VACUUM: 5,
  MOP: 6,
};

export const BATTERY_BOUNDS = { MIN: 0, MAX: 100 };

// Devices are polled every 30 seconds. A robot barely changes state while
// docked; a command triggers an immediate refresh anyway (see index.js).
// Must be one of the Gladys DEVICE_POLL_FREQUENCIES values, in milliseconds.
export const POLL_FREQUENCY = 30 * 1000;

// --- Roborock cloud ----------------------------------------------------------

// Region base URLs, tried in turn. The legacy `getUrlByEmail` region-lookup
// endpoint is deprecated (verified: it just echoes whichever host you ask, with
// a null country), so the region is found by attempting the login on each.
// The env var override is only used by the test suite.
export const ROBOROCK_BASE_URLS = (
  process.env.ROBOROCK_BASE_URLS ||
  'https://usiot.roborock.com,https://euiot.roborock.com,https://cniot.roborock.com,https://ruiot.roborock.com'
)
  .split(',')
  .map((url) => url.trim().replace(/\/+$/, ''))
  .filter(Boolean);

// AES key salt of the Roborock "1.0" key derivation.
export const ROBOROCK_V1_SALT = 'TXdfu$jyZ#TZHsg4';

// The 3-byte version header selecting the crypto family. Only "1.0" is
// implemented: it covers the vast majority of the vacuums. A01/B01/L01 devices
// (recent Dyad / Zeo ranges) use different schemes.
export const ROBOROCK_PROTOCOL_VERSION = '1.0';

// Roborock message protocol ids.
export const ROBOROCK_MESSAGE_PROTOCOL = {
  RPC_REQUEST: 101,
  RPC_RESPONSE: 102,
  MAP_RESPONSE: 301,
};

// Local (LAN) TCP port exposed by Roborock vacuums. The env var override is
// only used by the test suite.
export const ROBOROCK_LOCAL_PORT = Number(process.env.ROBOROCK_LOCAL_PORT) || 58867;

// --- Roborock/miIO RPC methods -----------------------------------------------

export const ROBOROCK_METHOD = {
  GET_STATUS: 'get_status',
  APP_START: 'app_start',
  APP_STOP: 'app_stop',
  APP_PAUSE: 'app_pause',
  APP_CHARGE: 'app_charge',
  SET_FAN_POWER: 'set_custom_mode',
  GET_FAN_POWER: 'get_custom_mode',
  GET_NETWORK_INFO: 'get_network_info',
};

// --- Roborock state codes (RoborockStateCode) --------------------------------
// int -> Gladys VACUUM_CLEANER_STATE. States not listed are reported as-is
// (skipped) — the mapping is intentionally exhaustive over the known codes.
export const ROBOROCK_STATE_TO_GLADYS = {
  0: null, // unknown
  1: VACUUM_CLEANER_STATE.RUNNING, // starting
  2: VACUUM_CLEANER_STATE.STOPPED, // charger_disconnected
  3: VACUUM_CLEANER_STATE.STOPPED, // idle
  4: VACUUM_CLEANER_STATE.RUNNING, // remote_control_active
  5: VACUUM_CLEANER_STATE.RUNNING, // cleaning
  6: VACUUM_CLEANER_STATE.RETURNING_TO_DOCK, // returning_home
  7: VACUUM_CLEANER_STATE.RUNNING, // manual_mode
  8: VACUUM_CLEANER_STATE.CHARGING, // charging
  9: VACUUM_CLEANER_STATE.ERROR, // charging_problem
  10: VACUUM_CLEANER_STATE.PAUSED, // paused
  11: VACUUM_CLEANER_STATE.RUNNING, // spot_cleaning
  12: VACUUM_CLEANER_STATE.ERROR, // error
  13: VACUUM_CLEANER_STATE.STOPPED, // shutting_down
  14: VACUUM_CLEANER_STATE.STOPPED, // updating
  15: VACUUM_CLEANER_STATE.RETURNING_TO_DOCK, // docking
  16: VACUUM_CLEANER_STATE.RUNNING, // going_to_target
  17: VACUUM_CLEANER_STATE.RUNNING, // zoned_cleaning
  18: VACUUM_CLEANER_STATE.RUNNING, // segment_cleaning
  22: VACUUM_CLEANER_STATE.DOCKED, // emptying_the_bin
  23: VACUUM_CLEANER_STATE.DOCKED, // washing_the_mop
  25: VACUUM_CLEANER_STATE.DOCKED, // washing_the_mop_2
  26: VACUUM_CLEANER_STATE.RETURNING_TO_DOCK, // going_to_wash_the_mop
  28: VACUUM_CLEANER_STATE.RUNNING, // in_call
  29: VACUUM_CLEANER_STATE.RUNNING, // mapping
  30: VACUUM_CLEANER_STATE.RUNNING, // egg_attack
  32: VACUUM_CLEANER_STATE.RUNNING, // patrol
  33: VACUUM_CLEANER_STATE.DOCKED, // attaching_the_mop
  34: VACUUM_CLEANER_STATE.DOCKED, // detaching_the_mop
  100: VACUUM_CLEANER_STATE.DOCKED, // charging_complete
  101: VACUUM_CLEANER_STATE.ERROR, // device_offline
  103: VACUUM_CLEANER_STATE.STOPPED, // locked
  202: VACUUM_CLEANER_STATE.DOCKED, // air_drying_stopping
  6301: VACUUM_CLEANER_STATE.RUNNING, // robot_status_mopping
  6302: VACUUM_CLEANER_STATE.RUNNING, // clean_mop_cleaning
  6303: VACUUM_CLEANER_STATE.RUNNING, // clean_mop_mopping
  6304: VACUUM_CLEANER_STATE.RUNNING, // segment_mopping
  6305: VACUUM_CLEANER_STATE.RUNNING, // segment_clean_mop_cleaning
  6306: VACUUM_CLEANER_STATE.RUNNING, // segment_clean_mop_mopping
  6307: VACUUM_CLEANER_STATE.RUNNING, // zoned_mopping
  6308: VACUUM_CLEANER_STATE.RUNNING, // zoned_clean_mop_cleaning
  6309: VACUUM_CLEANER_STATE.RUNNING, // zoned_clean_mop_mopping
  6310: VACUUM_CLEANER_STATE.RETURNING_TO_DOCK, // back_to_dock_washing_duster
};

// Roborock states that mean "a cleaning task is in progress" — used to derive
// the run-mode feedback (CLEANING vs IDLE).
export const ROBOROCK_CLEANING_STATES = new Set([
  1, 4, 5, 7, 11, 16, 17, 18, 28, 29, 30, 32, 6301, 6302, 6303, 6304, 6305, 6306, 6307, 6308, 6309,
]);

// --- Roborock fan power <-> Gladys clean mode --------------------------------
// Gladys exposes a fixed list of clean modes; Roborock exposes suction levels.
//
// VERIFIED ON REAL HARDWARE (Roborock S6, fw 3.5.8_2700): codes 101..105 are
// accepted and read back correctly, but 106 ("auto") is SILENTLY IGNORED — the
// device falls back to 102. So only the five verified codes are ever written;
// 106 is accepted on read as an alias of AUTO for the models that report it.
export const CLEAN_MODE_TO_FAN_POWER = {
  [VACUUM_CLEANER_CLEAN_MODE.QUIET]: 101, // silent
  [VACUUM_CLEANER_CLEAN_MODE.AUTO]: 102, // balanced (the sane default, always supported)
  [VACUUM_CLEANER_CLEAN_MODE.DEEP_CLEAN]: 103, // turbo
  [VACUUM_CLEANER_CLEAN_MODE.VACUUM]: 104, // max
  [VACUUM_CLEANER_CLEAN_MODE.LOW_NOISE]: 105, // gentle
};

// Reverse map (Roborock fan power -> Gladys clean mode), derived from the table
// above so the two never drift apart, plus the read-only 106 alias.
export const FAN_POWER_TO_CLEAN_MODE = {
  ...Object.fromEntries(
    Object.entries(CLEAN_MODE_TO_FAN_POWER).map(([cleanMode, fanPower]) => [
      fanPower,
      Number(cleanMode),
    ]),
  ),
  106: VACUUM_CLEANER_CLEAN_MODE.AUTO, // auto, read-only (see above)
};

// Feature suffixes used in the feature external ids
// (`ext:<selector>:vacuum:<duid>:<code>`).
export const FEATURE_CODES = {
  STATE: 'state',
  RUN_MODE: 'run-mode',
  CLEAN_MODE: 'clean-mode',
  DOCK: 'dock',
  BATTERY: 'battery',
  ROUTINE_PREFIX: 'routine-',
};
