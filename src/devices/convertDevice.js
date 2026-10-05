// -----------------------------------------------------------------------------
// Convert a Roborock device (from the HomeData) into a Gladys discovered-device
// payload.
//
// External id scheme (built with gladys.externalIds(), mandatory prefix
// `ext:<selector>:`):
//   device  -> ext:<selector>:vacuum:<duid>
//   feature -> ext:<selector>:vacuum:<duid>:<state|run-mode|clean-mode|dock|battery>
//
// The duid is enough to address the robot on both transports (the localKey is
// re-fetched from the cloud at login), so no extra device param is needed.
// -----------------------------------------------------------------------------

import { POLL_FREQUENCY } from '../constants.js';
import { buildDockFeatures, buildVacuumFeatures } from './vacuum.js';
import { buildLastCleanStartFeature } from './lastClean.js';

export const VACUUM_SLUG = 'vacuum';
export const DOCK_SLUG = 'dock';

/**
 * Stamp an explicit, globally-unique selector on each feature.
 *
 * A Gladys device-feature `selector` is UNIQUE across the whole instance. When
 * a feature is published without one, Gladys derives it from the name
 * (e.g. "State" -> "state"), which collides with any other device/integration
 * exposing a feature with the same name. Basing it on the already-unique
 * external_id keeps it globally unique.
 * @param {Array} features Gladys features (each with an external_id)
 * @returns {Array} the same features, each carrying a unique `selector`
 */
function withFeatureSelectors(features) {
  return features.map((feature) => ({
    ...feature,
    selector: feature.external_id,
  }));
}

/**
 * Build the external ids (device + feature factory) of a Roborock robot.
 * @param {import('@gladysassistant/integration-sdk').GladysIntegration} gladys
 * @param {string} duid the Roborock device id
 * @returns {object} `{ device, feature(featureKey) }`
 */
export function vacuumExternalIds(gladys, duid) {
  return gladys.externalIds(VACUUM_SLUG, String(duid));
}

/**
 * Build the external ids of the dock attached to one robot.
 * @param {import('@gladysassistant/integration-sdk').GladysIntegration} gladys
 * @param {string} duid the parent Roborock device id
 * @returns {object} `{ device, feature(featureKey) }`
 */
export function dockExternalIds(gladys, duid) {
  return gladys.externalIds(DOCK_SLUG, String(duid));
}

/**
 * Convert a Roborock robot into a Gladys discovered device.
 * @param {import('@gladysassistant/integration-sdk').GladysIntegration} gladys
 * @param {object} device a Roborock device (from RoborockClient.listDevices())
 * @returns {object} Gladys discovered device
 */
export function convertDevice(gladys, device) {
  const ids = vacuumExternalIds(gladys, device.duid);
  return {
    name: device.name,
    external_id: ids.device,
    model: device.model || null,
    poll_frequency: POLL_FREQUENCY,
    should_poll: true,
    features: withFeatureSelectors([
      ...buildVacuumFeatures(ids, device.routines, device.rooms),
      buildLastCleanStartFeature(ids),
    ]),
  };
}

/**
 * Convert a Roborock dock into a separate Gladys discovered device.
 * Communication still goes through the parent robot duid.
 * @param {import('@gladysassistant/integration-sdk').GladysIntegration} gladys
 * @param {object} device the parent Roborock robot
 * @param {number} dockType get_status.dock_type
 * @returns {object} Gladys discovered dock device
 */
export function convertDockDevice(gladys, device, dockType) {
  const ids = dockExternalIds(gladys, device.duid);
  return {
    name: `${device.name} - Dock`,
    external_id: ids.device,
    model: `Roborock dock type ${dockType}`,
    poll_frequency: POLL_FREQUENCY,
    should_poll: true,
    features: withFeatureSelectors(buildDockFeatures(ids)),
  };
}
