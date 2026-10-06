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
  CONSUMABLE_BOUNDS,
  CONSUMABLE_LIFETIME,
  CLEAN_MODE_TO_FAN_POWER,
  FAN_POWER_TO_CLEAN_MODE,
  FEATURE_CODES,
  ROBOROCK_CLEANING_STATES,
  ROBOROCK_METHOD,
  ROBOROCK_STATE_TO_GLADYS,
  ROOM_SELECTION_NONE,
  VACUUM_CLEANER_MODE,
  VACUUM_CLEANER_STATE,
} from '../constants.js';

/**
 * Build the Gladys features of a Roborock robot.
 * @param {object} ids external ids of the Gladys device (from gladys.externalIds()):
 *   `{ device, feature(featureKey) }`
 * @returns {Array} Gladys device features
 */
export function buildVacuumFeatures(ids, routines = [], rooms = []) {
  const features = [
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
    {
      name: 'Main brush',
      external_id: ids.feature(FEATURE_CODES.MAIN_BRUSH),
      read_only: true,
      has_feedback: true,
      keep_history: true,
      min: CONSUMABLE_BOUNDS.MIN,
      max: CONSUMABLE_BOUNDS.MAX,
      unit: DEVICE_FEATURE_UNITS.PERCENT,
      category: DEVICE_FEATURE_CATEGORIES.MAINTENANCE,
      type: DEVICE_FEATURE_TYPES.MAINTENANCE.LIFE_REMAINING,
    },
    {
      name: 'Side brush',
      external_id: ids.feature(FEATURE_CODES.SIDE_BRUSH),
      read_only: true,
      has_feedback: true,
      keep_history: true,
      min: CONSUMABLE_BOUNDS.MIN,
      max: CONSUMABLE_BOUNDS.MAX,
      unit: DEVICE_FEATURE_UNITS.PERCENT,
      category: DEVICE_FEATURE_CATEGORIES.MAINTENANCE,
      type: DEVICE_FEATURE_TYPES.MAINTENANCE.LIFE_REMAINING,
    },
    {
      name: 'Filter',
      external_id: ids.feature(FEATURE_CODES.FILTER),
      read_only: true,
      has_feedback: true,
      keep_history: true,
      min: CONSUMABLE_BOUNDS.MIN,
      max: CONSUMABLE_BOUNDS.MAX,
      unit: DEVICE_FEATURE_UNITS.PERCENT,
      category: DEVICE_FEATURE_CATEGORIES.MAINTENANCE,
      type: DEVICE_FEATURE_TYPES.MAINTENANCE.LIFE_REMAINING,
    },
    {
      name: 'Sensor cleaning',
      external_id: ids.feature(FEATURE_CODES.SENSOR_CLEANING),
      read_only: true,
      has_feedback: true,
      keep_history: true,
      min: CONSUMABLE_BOUNDS.MIN,
      max: CONSUMABLE_BOUNDS.MAX,
      unit: DEVICE_FEATURE_UNITS.PERCENT,
      category: DEVICE_FEATURE_CATEGORIES.MAINTENANCE,
      type: DEVICE_FEATURE_TYPES.MAINTENANCE.LIFE_REMAINING,
    },
  ];

  if (rooms.length > 0) {
    features.push({
      name: 'Room to clean',
      external_id: ids.feature(FEATURE_CODES.ROOM),
      read_only: false,
      has_feedback: false,
      keep_history: false,
      min: 0,
      max: 0,
      category: DEVICE_FEATURE_CATEGORIES.TEXT,
      type: DEVICE_FEATURE_TYPES.TEXT.SELECT,
      supported_options: [
        {
          value: ROOM_SELECTION_NONE,
          label: '—',
          sort_order: 0,
        },
        ...rooms.map((room, index) => ({
          value: String(room.id),
          label: room.name,
          sort_order: index + 1,
        })),
      ],
    });
  }

  for (const routine of routines) {
    features.push({
      name: `Routine - ${routine.name}`,
      external_id: ids.feature(`${FEATURE_CODES.ROUTINE_PREFIX}${routine.id}`),
      read_only: false,
      has_feedback: false,
      keep_history: false,
      min: 0,
      max: 1,
      category: DEVICE_FEATURE_CATEGORIES.BUTTON,
      type: DEVICE_FEATURE_TYPES.BUTTON.PUSH,
    });
  }

  return features;
}

/**
 * Build maintenance features exposed by a Roborock dock.
 * @param {object} ids external ids of the Gladys dock device
 * @returns {Array} Gladys dock features
 */
export function buildDockFeatures(ids) {
  return [
    {
      name: 'Strainer',
      external_id: ids.feature(FEATURE_CODES.DOCK_STRAINER),
      read_only: true,
      has_feedback: true,
      keep_history: true,
      min: CONSUMABLE_BOUNDS.MIN,
      max: CONSUMABLE_BOUNDS.MAX,
      unit: DEVICE_FEATURE_UNITS.PERCENT,
      category: DEVICE_FEATURE_CATEGORIES.MAINTENANCE,
      type: DEVICE_FEATURE_TYPES.MAINTENANCE.LIFE_REMAINING,
    },
    {
      name: 'Cleaning brush',
      external_id: ids.feature(FEATURE_CODES.DOCK_CLEANING_BRUSH),
      read_only: true,
      has_feedback: true,
      keep_history: true,
      min: CONSUMABLE_BOUNDS.MIN,
      max: CONSUMABLE_BOUNDS.MAX,
      unit: DEVICE_FEATURE_UNITS.PERCENT,
      category: DEVICE_FEATURE_CATEGORIES.MAINTENANCE,
      type: DEVICE_FEATURE_TYPES.MAINTENANCE.LIFE_REMAINING,
    },
    {
      name: 'Dust collection',
      external_id: ids.feature(FEATURE_CODES.DUST_COLLECTION),
      read_only: true,
      has_feedback: true,
      keep_history: true,
      min: CONSUMABLE_BOUNDS.MIN,
      max: CONSUMABLE_BOUNDS.MAX,
      unit: DEVICE_FEATURE_UNITS.PERCENT,
      category: DEVICE_FEATURE_CATEGORIES.MAINTENANCE,
      type: DEVICE_FEATURE_TYPES.MAINTENANCE.LIFE_REMAINING,
    },
  ];
}

/**
 * Extract a Roborock scene id from a routine feature code.
 * @param {string} featureCode the last segment of a feature external id
 * @returns {number|null} the scene id, or null for a non-routine feature
 */
export function routineIdFromFeatureCode(featureCode) {
  if (!featureCode.startsWith(FEATURE_CODES.ROUTINE_PREFIX)) {
    return null;
  }
  const id = Number(featureCode.slice(FEATURE_CODES.ROUTINE_PREFIX.length));
  return Number.isSafeInteger(id) && id >= 0 ? id : null;
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

function remainingPercent(consumed, lifetime) {
  return Math.round(Math.max(0, Math.min(100, (1 - consumed / lifetime) * 100)));
}

/**
 * Remaining life of a consumable as a percentage, or null when unknown.
 * @param {*} consumed seconds of wear reported by the robot
 * @param {number} lifetime the consumable lifetime in seconds
 * @returns {number|null} 0-100 (rounded), or null when `consumed` is not a number
 */
export function consumableRemaining(consumed, lifetime) {
  const value = toNumber(consumed);
  return value === null ? null : remainingPercent(value, lifetime);
}

// Consumable -> (status field, lifetime). Single source for the Gladys features,
// the widget status block and the `consumable_worn` scene trigger.
const CONSUMABLE_FIELDS = {
  mainBrush: ['main_brush_work_time', CONSUMABLE_LIFETIME.MAIN_BRUSH_SECONDS],
  sideBrush: ['side_brush_work_time', CONSUMABLE_LIFETIME.SIDE_BRUSH_SECONDS],
  filter: ['filter_work_time', CONSUMABLE_LIFETIME.FILTER_SECONDS],
  sensor: ['sensor_dirty_time', CONSUMABLE_LIFETIME.SENSOR_SECONDS],
};

/**
 * Remaining life of every tracked consumable, in percent (null when unknown).
 * @param {object} consumable the get_consumable result
 * @returns {{ mainBrush: number|null, sideBrush: number|null, filter: number|null, sensor: number|null }}
 */
export function consumablePercents(consumable) {
  const value = consumable || {};
  const percents = {};
  for (const [name, [field, lifetime]] of Object.entries(CONSUMABLE_FIELDS)) {
    percents[name] = consumableRemaining(value[field], lifetime);
  }
  return percents;
}

/**
 * Convert robot maintenance counters returned by get_consumable to percentages.
 * Missing values are ignored so older models stay compatible.
 * @param {object} ids external ids of the Gladys robot
 * @param {object} consumable get_consumable result
 * @returns {Array} states for gladys.publishStates()
 */
export function buildConsumableStates(ids, consumable) {
  const states = [];
  const mappings = [
    [FEATURE_CODES.MAIN_BRUSH, 'main_brush_work_time', CONSUMABLE_LIFETIME.MAIN_BRUSH_SECONDS],
    [FEATURE_CODES.SIDE_BRUSH, 'side_brush_work_time', CONSUMABLE_LIFETIME.SIDE_BRUSH_SECONDS],
    [FEATURE_CODES.FILTER, 'filter_work_time', CONSUMABLE_LIFETIME.FILTER_SECONDS],
    [FEATURE_CODES.SENSOR_CLEANING, 'sensor_dirty_time', CONSUMABLE_LIFETIME.SENSOR_SECONDS],
  ];

  for (const [featureCode, field, lifetime] of mappings) {
    const consumed = toNumber(consumable && consumable[field]);
    if (consumed === null) {
      continue;
    }
    states.push({
      device_feature_external_id: ids.feature(featureCode),
      state: remainingPercent(consumed, lifetime),
    });
  }

  return states;
}

/**
 * Convert dock maintenance counters returned by get_consumable to percentages.
 * Missing values are ignored because dock generations expose different fields.
 * @param {object} ids external ids of the Gladys dock
 * @param {object} consumable get_consumable result
 * @returns {Array} states for gladys.publishStates()
 */
export function buildDockStates(ids, consumable) {
  const states = [];
  const mappings = [
    [FEATURE_CODES.DOCK_STRAINER, 'strainer_work_times', CONSUMABLE_LIFETIME.DOCK_STRAINER_CYCLES],
    [
      FEATURE_CODES.DOCK_CLEANING_BRUSH,
      'cleaning_brush_work_times',
      CONSUMABLE_LIFETIME.DOCK_CLEANING_BRUSH_CYCLES,
    ],
    [
      FEATURE_CODES.DUST_COLLECTION,
      'dust_collection_work_times',
      CONSUMABLE_LIFETIME.DUST_COLLECTION_CYCLES,
    ],
  ];

  for (const [featureCode, field, lifetime] of mappings) {
    const consumed = toNumber(consumable && consumable[field]);
    if (consumed === null) {
      continue;
    }
    states.push({
      device_feature_external_id: ids.feature(featureCode),
      state: remainingPercent(consumed, lifetime),
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
    case FEATURE_CODES.ROOM: {
      const segmentId = toNumber(value);
      return Number.isSafeInteger(segmentId) && segmentId >= 0
        ? {
            method: ROBOROCK_METHOD.APP_SEGMENT_CLEAN,
            params: [
              {
                segments: [segmentId],
              },
            ],
          }
        : null;
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
