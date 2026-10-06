// -----------------------------------------------------------------------------
// Roborock scene actions (manifest `scene_actions`).
//
// A scene action is a command the scene engine sends to the integration
// (onSceneAction). Each action carries a `vacuum` field (source: "devices") so
// the author picks the target robot; index.js parses its duid and forwards the
// Roborock RPC. These helpers resolve the free-text fields (rooms, routine) the
// manifest cannot populate dynamically, and stay pure for unit testing.
// -----------------------------------------------------------------------------

import { VACUUM_CLEANER_CLEAN_MODE } from '../constants.js';

// Stable manifest keys (never renamed once published).
export const SCENE_ACTIONS = {
  START_CLEANING: 'start_cleaning',
  CLEAN_ROOMS: 'clean_rooms',
  PAUSE_CLEANING: 'pause_cleaning',
  STOP_CLEANING: 'stop_cleaning',
  RETURN_TO_DOCK: 'return_to_dock',
  SET_FAN_POWER: 'set_fan_power',
  RUN_ROUTINE: 'run_routine',
};

// `mode` field value (manifest select) -> internal clean-mode value.
export const FAN_POWER_MODES = {
  quiet: VACUUM_CLEANER_CLEAN_MODE.QUIET,
  balanced: VACUUM_CLEANER_CLEAN_MODE.AUTO,
  turbo: VACUUM_CLEANER_CLEAN_MODE.DEEP_CLEAN,
  max: VACUUM_CLEANER_CLEAN_MODE.VACUUM,
};

/**
 * Resolve the free-text `rooms` field to Roborock segment ids.
 *
 * Accepts a comma-separated list of room NAMES (matched case-insensitively
 * against the robot's rooms) and/or raw numeric segment ids. Unknown names are
 * skipped; duplicates are removed.
 * @param {string} input the `rooms` field value (e.g. "Cuisine, Salon")
 * @param {Array<{id: number, name: string}>} rooms the robot's rooms
 * @returns {number[]} the resolved segment ids
 */
export function resolveRoomSegments(input, rooms = []) {
  const byName = new Map(
    rooms
      .filter((room) => room && room.name !== undefined && room.id !== undefined)
      .map((room) => [String(room.name).trim().toLowerCase(), Number(room.id)]),
  );
  const ids = [];
  for (const token of String(input || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)) {
    if (/^\d+$/.test(token)) {
      ids.push(Number(token));
      continue;
    }
    const id = byName.get(token.toLowerCase());
    if (id !== undefined && Number.isSafeInteger(id)) {
      ids.push(id);
    }
  }
  return [...new Set(ids)];
}

/**
 * Resolve the free-text `routine` field to a Roborock routine id.
 *
 * Accepts a routine NAME (matched case-insensitively) or a raw numeric id.
 * @param {string} input the `routine` field value (e.g. "Nettoyage cuisine")
 * @param {Array<{id: number, name: string}>} routines the robot's routines
 * @returns {number|null} the routine id, or null when unresolved
 */
export function resolveRoutineId(input, routines = []) {
  const token = String(input || '').trim();
  if (!token) {
    return null;
  }
  if (/^\d+$/.test(token)) {
    return Number(token);
  }
  const match = routines.find(
    (routine) => routine && String(routine.name).trim().toLowerCase() === token.toLowerCase(),
  );
  return match && Number.isSafeInteger(Number(match.id)) ? Number(match.id) : null;
}
