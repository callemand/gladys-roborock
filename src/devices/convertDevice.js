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
import { buildVacuumFeatures } from './vacuum.js';

export const VACUUM_SLUG = 'vacuum';

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
  return features.map((feature) => ({ ...feature, selector: feature.external_id }));
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
    features: withFeatureSelectors(buildVacuumFeatures(ids)),
  };
}
