// -----------------------------------------------------------------------------
// Roborock scene triggers (manifest `scene_triggers`).
//
// A trigger is a TRANSITION, never a state: on each poll the integration builds
// a normalized snapshot of the robot and compares it with the previous one;
// every crossing (started cleaning, docked, battery dropped under a threshold…)
// becomes one scene event published through gladys.publishSceneEvent.
//
// Pure functions only (no I/O), so index.js owns the per-robot snapshot cache
// and the publishing, and the logic stays unit-testable.
// -----------------------------------------------------------------------------

import {
  ROBOROCK_CLEANING_STATES,
  ROBOROCK_STATE_TO_GLADYS,
  VACUUM_CLEANER_STATE,
} from '../constants.js';
import { roborockStateLabel } from './mapWidget.js';

// Stable manifest keys (never renamed once published).
export const SCENE_TRIGGERS = {
  CLEANING_STARTED: 'cleaning_started',
  CLEANING_FINISHED: 'cleaning_finished',
  RETURNED_TO_DOCK: 'returned_to_dock',
  BATTERY_LOW: 'battery_low',
  CHARGING_COMPLETE: 'charging_complete',
  ROBOT_ERROR: 'robot_error',
  CONSUMABLE_WORN: 'consumable_worn',
  STATE_CHANGED: 'state_changed',
};

// Integration-side thresholds: scene trigger filters are equality-only, so a "<"
// comparison cannot live in the manifest. The crossing is detected here and the
// level/percentage is exposed as a variable for an in-scene condition.
export const BATTERY_LOW_THRESHOLD = 20;
export const CONSUMABLE_LOW_THRESHOLD = 10;

// Snapshot consumable key -> scene variable value (the `consumable` filter).
export const CONSUMABLE_KINDS = [
  { key: 'filter', value: 'filter' },
  { key: 'mainBrush', value: 'main_brush' },
  { key: 'sideBrush', value: 'side_brush' },
  { key: 'sensor', value: 'sensor' },
];

// A small, best-effort map of Roborock error codes to a short French label.
// Unknown codes fall back to "Erreur <code>".
const ERROR_LABELS = {
  1: 'Capteur laser bloqué',
  2: 'Pare-chocs bloqué',
  3: 'Roue dans le vide',
  4: 'Capteur de vide sale',
  5: 'Brosse principale bloquée',
  6: 'Brosse latérale bloquée',
  7: 'Roue bloquée',
  8: 'Robot coincé',
  9: 'Bac à poussière absent',
  10: 'Filtre bouché',
  11: 'Champ magnétique détecté',
  12: 'Batterie faible',
  13: 'Problème de charge',
  14: 'Batterie défectueuse',
  15: 'Capteur mural sale',
  16: 'Robot sur une surface inclinée',
  17: 'Brosse latérale défectueuse',
  18: 'Ventilateur défectueux',
  19: 'Base non alimentée',
  21: 'Capteur anti-chute bloqué',
  24: 'Zone interdite détectée',
};

/**
 * Short French label for a Roborock error code.
 * @param {number} code the error code
 * @returns {string} the label
 */
export function errorLabel(code) {
  return ERROR_LABELS[Number(code)] || `Erreur ${Number(code)}`;
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Build the normalized snapshot compared between two polls.
 * @param {object} status a get_status result
 * @param {object} percents remaining consumable life % { filter, mainBrush, sideBrush, sensor }
 * @returns {object} the snapshot
 */
export function snapshotFromStatus(status = {}, percents = {}) {
  const rawState = numberOrNull(status.state);
  const gladysState = rawState === null ? null : (ROBOROCK_STATE_TO_GLADYS[rawState] ?? null);
  return {
    rawState,
    gladysState,
    battery: numberOrNull(status.battery),
    cleaning: rawState !== null && ROBOROCK_CLEANING_STATES.has(rawState),
    docked:
      gladysState === VACUUM_CLEANER_STATE.CHARGING || gladysState === VACUUM_CLEANER_STATE.DOCKED,
    error: gladysState === VACUUM_CLEANER_STATE.ERROR,
    errorCode: numberOrNull(status.error_code) ?? 0,
    cleanTimeSec: Number(status.clean_time) || 0,
    cleanAreaMm2: Number(status.clean_area) || 0,
    percents: {
      filter: numberOrNull(percents.filter),
      mainBrush: numberOrNull(percents.mainBrush),
      sideBrush: numberOrNull(percents.sideBrush),
      sensor: numberOrNull(percents.sensor),
    },
  };
}

/**
 * Whether a cleaning session is still ongoing in the current snapshot.
 *
 * A session starts when the robot cleans and spans the non-cleaning states that
 * are part of the same job — paused, returning to the dock, mid-job recharge and
 * error (stuck mid-clean). It ends only once the robot is genuinely idle at the
 * dock. This keeps a pause/resume (or a mop wash on the way home) from reading as
 * a finished-then-restarted cleaning.
 * @param {boolean} previousActive whether a session was active at the last poll
 * @param {object} snapshot the current snapshot
 * @returns {boolean} whether a session is active now
 */
function nextSessionActive(previousActive, snapshot) {
  if (snapshot.cleaning) {
    return true;
  }
  const continues =
    snapshot.gladysState === VACUUM_CLEANER_STATE.PAUSED ||
    snapshot.gladysState === VACUUM_CLEANER_STATE.RETURNING_TO_DOCK ||
    snapshot.gladysState === VACUUM_CLEANER_STATE.ERROR;
  return previousActive && continues;
}

/**
 * Compare two snapshots and return the scene events for every transition.
 * A null `previous` only seeds the cache (no event on the first poll). The
 * current snapshot is tagged with `sessionActive` so the caller can store it.
 * @param {object|null} previous the previous snapshot
 * @param {object} current the current snapshot (mutated: `sessionActive` is set)
 * @param {object} ctx context
 * @param {string} ctx.vacuum the vacuum device external_id (the `vacuum` filter)
 * @param {string} ctx.deviceName the robot name (the `device_name` variable)
 * @returns {Array<{key: string, data: object}>} the events to publish
 */
export function computeSceneEvents(previous, current, { vacuum, deviceName }) {
  const events = [];
  const previousActive = previous ? Boolean(previous.sessionActive) : false;
  current.sessionActive = nextSessionActive(previousActive, current);
  if (!previous) {
    return events;
  }
  const base = { vacuum, device_name: deviceName };

  // A new session begins (not a resume from pause / returning / error).
  if (current.cleaning && !previousActive) {
    events.push({ key: SCENE_TRIGGERS.CLEANING_STARTED, data: { ...base } });
  }

  // The session ended: the robot returned to the dock for good.
  if (previousActive && !current.sessionActive) {
    events.push({
      key: SCENE_TRIGGERS.CLEANING_FINISHED,
      data: {
        ...base,
        duration_min: Math.round((current.cleanTimeSec || previous.cleanTimeSec) / 60),
        area_m2: Math.round((current.cleanAreaMm2 || previous.cleanAreaMm2) / 1e6),
      },
    });
  }

  if (current.docked && !previous.docked) {
    events.push({ key: SCENE_TRIGGERS.RETURNED_TO_DOCK, data: { ...base } });
  }

  if (
    current.battery !== null &&
    previous.battery !== null &&
    previous.battery > BATTERY_LOW_THRESHOLD &&
    current.battery <= BATTERY_LOW_THRESHOLD
  ) {
    events.push({ key: SCENE_TRIGGERS.BATTERY_LOW, data: { ...base, level: current.battery } });
  }

  if (current.battery === 100 && previous.battery !== null && previous.battery < 100) {
    events.push({ key: SCENE_TRIGGERS.CHARGING_COMPLETE, data: { ...base } });
  }

  if (current.error && !previous.error) {
    events.push({
      key: SCENE_TRIGGERS.ROBOT_ERROR,
      data: { ...base, error_code: current.errorCode, error_label: errorLabel(current.errorCode) },
    });
  }

  for (const kind of CONSUMABLE_KINDS) {
    const prev = previous.percents[kind.key];
    const cur = current.percents[kind.key];
    if (
      prev !== null &&
      cur !== null &&
      prev > CONSUMABLE_LOW_THRESHOLD &&
      cur <= CONSUMABLE_LOW_THRESHOLD
    ) {
      events.push({
        key: SCENE_TRIGGERS.CONSUMABLE_WORN,
        data: { ...base, consumable: kind.value, percent: Math.round(cur) },
      });
    }
  }

  if (current.rawState !== null && current.rawState !== previous.rawState) {
    events.push({
      key: SCENE_TRIGGERS.STATE_CHANGED,
      data: { ...base, state: roborockStateLabel(current.rawState), state_code: current.rawState },
    });
  }

  return events;
}
