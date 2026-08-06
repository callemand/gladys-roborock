// -----------------------------------------------------------------------------
// Minimal in-memory stand-in for the Gladys SDK object, for unit tests.
//
// It reproduces the only surface the device modules rely on:
//   - externalIds(type, platformId) -> { device, feature(key) }
//   - publishStates / publishTransports / setConnectionStatus -> record the
//     calls so tests can assert them
// This lets us test the pure "wiring" logic (discovery payloads, state mapping)
// without a running Gladys server or a real WebSocket. The end-to-end tests
// (test/e2e*.test.js) do the opposite: they boot the real index.js against a
// fake Gladys HOST, over HTTP and WebSocket.
// -----------------------------------------------------------------------------

// the selector the fake stands in for, mirroring the `ext:<selector>:` prefix
// the SDK builds
export const SELECTOR = 'test';

/**
 * Build the SDK stub.
 * @returns {object} the fake, with the recorded calls exposed
 */
export function createFakeGladys() {
  const published = [];
  const transports = [];
  const connectionStatuses = [];

  return {
    published,
    transports,
    connectionStatuses,

    externalIds(type, platformId) {
      const device = `ext:${SELECTOR}:${type}:${platformId}`;
      return {
        device,
        feature: (key) => `${device}:${key}`,
      };
    },

    async publishStates(states) {
      states.forEach((state) =>
        published.push({
          featureExternalId: state.device_feature_external_id,
          state: state.state,
        }),
      );
    },

    async publishTransports(entries) {
      transports.push(...entries);
    },

    async setConnectionStatus(connected, message) {
      connectionStatuses.push({ connected, message });
    },
  };
}

/**
 * The external ids of one vacuum, as the device modules receive them.
 * @param {string} duid the Roborock device id
 * @returns {object} `{ device, feature(code) }`
 */
export function fakeVacuumIds(duid) {
  return createFakeGladys().externalIds('vacuum', duid);
}
