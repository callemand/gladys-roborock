import { DEVICE_FEATURE_CATEGORIES, DEVICE_FEATURE_TYPES } from '@gladysassistant/integration-sdk';

import { FEATURE_CODES } from '../constants.js';

// Unix seconds. 4_102_444_800 = 2100-01-01T00:00:00Z.
// Gladys currently has no dedicated timestamp feature category/type, therefore
// this is deliberately exposed as an UNKNOWN numeric feature. The value remains
// usable as a regular numeric device state and keeps its history.
const MAX_UNIX_TIMESTAMP_SECONDS = 4_102_444_800;

/**
 * Build the read-only Gladys feature exposing the start of the last cleaning.
 *
 * @param {object} ids external-id factory of the vacuum
 * @returns {object} Gladys feature
 */
export function buildLastCleanStartFeature(ids) {
  return {
    name: 'Last clean start',
    external_id: ids.feature(FEATURE_CODES.LAST_CLEAN_START),
    category: DEVICE_FEATURE_CATEGORIES.UNKNOWN,
    type: DEVICE_FEATURE_TYPES.UNKNOWN.UNKNOWN,
    read_only: true,
    has_feedback: true,
    keep_history: true,
    min: 0,
    max: MAX_UNIX_TIMESTAMP_SECONDS,
  };
}

/**
 * Extract the most recent cleaning start timestamp from get_clean_summary.
 *
 * Verified on Roborock QV 35A (roborock.vacuum.a168):
 *   summary.records[0] === get_clean_record(records[0])[0].begin
 *
 * The RPC can be returned either as an object or as a single-element array
 * depending on transport/model.
 *
 * @param {object|Array|null} rawSummary get_clean_summary response
 * @returns {number|null} Unix timestamp in seconds
 */
export function extractLastCleanStart(rawSummary) {
  let summary = rawSummary;

  if (
    Array.isArray(rawSummary) &&
    rawSummary.length === 1 &&
    rawSummary[0] &&
    typeof rawSummary[0] === 'object' &&
    !Array.isArray(rawSummary[0])
  ) {
    [summary] = rawSummary;
  }

  if (!summary || typeof summary !== 'object') {
    return null;
  }

  const records = summary.records;

  if (!Array.isArray(records) || records.length === 0) {
    return null;
  }

  const timestamp = Number(records[0]);

  if (
    !Number.isSafeInteger(timestamp) ||
    timestamp <= 0 ||
    timestamp > MAX_UNIX_TIMESTAMP_SECONDS
  ) {
    return null;
  }

  return timestamp;
}

/**
 * Build a Gladys state for Last clean start.
 *
 * @param {object} ids external-id factory of the vacuum
 * @param {number|null} timestamp Unix timestamp in seconds
 * @returns {object|null} Gladys state or null
 */
export function buildLastCleanStartState(ids, timestamp) {
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    return null;
  }

  return {
    device_feature_external_id: ids.feature(FEATURE_CODES.LAST_CLEAN_START),
    state: timestamp,
  };
}
