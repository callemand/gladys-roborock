// -----------------------------------------------------------------------------
// Roborock robot vacuum -> Gladys features, state mapping and command mapping.
//
// Features exposed:
//   - state      (vacuum-cleaner / state, read-only)     <- Roborock `state`
//   - run-mode   (vacuum-cleaner / run-mode)             <- derived from state
//   - clean-mode (vacuum-cleaner / clean-mode)           <- Roborock `fan_power`
//   - dock       (vacuum-cleaner / dock, command-only)   -> app_charge
//   - battery    (battery / integer, read-only)          <- Roborock `battery`
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';

import {
  BATTERY_BOUNDS,
  CLEAN_MODE_TO_FAN_POWER,
  FAN_POWER_TO_CLEAN_MODE,
  FEATURE_CODES,
  ROBOROCK_CLEANING_STATES,
  ROBOROCK_METHOD,
  ROBOROCK_STATE_TO_GLADYS,
  VACUUM_CLEANER_MODE,
  VACUUM_CLEANER_STATE,
} from '../constants.js';

/**
 * Build the Gladys features of a Roborock robot.
 * @param {object} ids external ids of the Gladys device (from gladys.externalIds()):
 *   `{ device, feature(featureKey) }`
 * @returns {Array} Gladys device features
 */
export function buildVacuumFeatures(ids) {
  return [
    {
      name: 'State',
      external_id: ids.feature(FEATURE_CODES.STATE),
      read_only: true,
      has_feedback: true,
      keep_history: false,
      min: VACUUM_CLEANER_STATE.STOPPED,
      max: VACUUM_CLEANER_STATE.DOCKED,
      category: DEVICE_FEATURE_CATEGORIES.VACUUM_CLEANER,
      type: DEVICE_FEATURE_TYPES.VACUUM_CLEANER.STATE,
    },
    {
      name: 'Run mode',
      external_id: ids.feature(FEATURE_CODES.RUN_MODE),
      read_only: false,
      has_feedback: true,
      min: VACUUM_CLEANER_MODE.IDLE,
      max: VACUUM_CLEANER_MODE.MAPPING,
      category: DEVICE_FEATURE_CATEGORIES.VACUUM_CLEANER,
      type: DEVICE_FEATURE_TYPES.VACUUM_CLEANER.RUN_MODE,
    },
    {
      name: 'Clean mode',
      external_id: ids.feature(FEATURE_CODES.CLEAN_MODE),
      read_only: false,
      has_feedback: true,
      min: 0,
      max: 6,
      category: DEVICE_FEATURE_CATEGORIES.VACUUM_CLEANER,
      type: DEVICE_FEATURE_TYPES.VACUUM_CLEANER.CLEAN_MODE,
    },
    {
      name: 'Dock',
      external_id: ids.feature(FEATURE_CODES.DOCK),
      read_only: false,
      has_feedback: false,
      min: 0,
      max: 1,
      category: DEVICE_FEATURE_CATEGORIES.VACUUM_CLEANER,
      type: DEVICE_FEATURE_TYPES.VACUUM_CLEANER.DOCK,
    },
    {
      name: 'Battery',
      external_id: ids.feature(FEATURE_CODES.BATTERY),
      read_only: true,
      has_feedback: true,
      keep_history: true,
      min: BATTERY_BOUNDS.MIN,
      max: BATTERY_BOUNDS.MAX,
      unit: DEVICE_FEATURE_UNITS.PERCENT,
      category: DEVICE_FEATURE_CATEGORIES.BATTERY,
      type: DEVICE_FEATURE_TYPES.BATTERY.INTEGER,
    },
  ];
}

/**
 * Map a Roborock status to the Gladys states of the vacuum features.
 * States without a known value are skipped.
 * @param {object} ids external ids of the Gladys device (from gladys.externalIds())
 * @param {object} status the Roborock get_status result
 * @returns {Array} states for gladys.publishStates()
 */
export function buildPollStates(ids, status) {
  const states = [];
  const roborockState = toNumber(status && status.state);
  const gladysState = roborockState === null ? null : ROBOROCK_STATE_TO_GLADYS[roborockState];

  if (gladysState !== null && gladysState !== undefined) {
    states.push({
      device_feature_external_id: ids.feature(FEATURE_CODES.STATE),
      state: gladysState,
    });
  }

  if (roborockState !== null) {
    states.push({
      device_feature_external_id: ids.feature(FEATURE_CODES.RUN_MODE),
      state: ROBOROCK_CLEANING_STATES.has(roborockState)
        ? VACUUM_CLEANER_MODE.CLEANING
        : VACUUM_CLEANER_MODE.IDLE,
    });
  }

  const fanPower = toNumber(status && status.fan_power);
  const cleanMode = fanPower === null ? undefined : FAN_POWER_TO_CLEAN_MODE[fanPower];
  if (cleanMode !== undefined) {
    states.push({
      device_feature_external_id: ids.feature(FEATURE_CODES.CLEAN_MODE),
      state: cleanMode,
    });
  }

  const battery = toNumber(status && status.battery);
  if (battery !== null) {
    states.push({
      device_feature_external_id: ids.feature(FEATURE_CODES.BATTERY),
      state: battery,
    });
  }

  return states;
}

/**
 * Map a Gladys command to the Roborock RPC to send. Returns null when the
 * command is not actionable (e.g. an unmapped clean mode, or dock=0).
 * @param {string} featureCode last segment of the feature external id
 * @param {number} value value sent by Gladys
 * @returns {{ method: string, params: Array }|null} the RPC to send
 */
export function buildSetCommand(featureCode, value) {
  switch (featureCode) {
    case FEATURE_CODES.RUN_MODE:
      // CLEANING starts a cycle, IDLE stops it. MAPPING is not a command.
      if (value === VACUUM_CLEANER_MODE.CLEANING) {
        return { method: ROBOROCK_METHOD.APP_START, params: [] };
      }
      if (value === VACUUM_CLEANER_MODE.IDLE) {
        return { method: ROBOROCK_METHOD.APP_STOP, params: [] };
      }
      return null;
    case FEATURE_CODES.CLEAN_MODE: {
      const fanPower = CLEAN_MODE_TO_FAN_POWER[value];
      return fanPower === undefined
        ? null
        : { method: ROBOROCK_METHOD.SET_FAN_POWER, params: [fanPower] };
    }
    case FEATURE_CODES.DOCK:
      // Only "go home" (value 1) is actionable, like the Matter integration.
      return value === 1 ? { method: ROBOROCK_METHOD.APP_CHARGE, params: [] } : null;
    default:
      return null;
  }
}

/**
 * Parse a value into a number.
 * @param {*} value the raw value
 * @returns {number|null} the parsed number, or null if not parseable
 */
function toNumber(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isNaN(parsed) ? null : parsed;
}
