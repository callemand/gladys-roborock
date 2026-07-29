// -----------------------------------------------------------------------------
// Entry point of the Gladys Roborock external integration.
//
//   - links the Xiaomi account ONCE through a QR login (the `link_account`
//     action), persists the session, then reconnects silently on every start;
//   - publishes the account robots as discovered devices (each robot exposes
//     state / run-mode / clean-mode / dock / battery features);
//   - answers the polls of Gladys with the current robot status;
//   - forwards user commands to the robot (local network first, cloud fallback).
//
// Environment variables provided by the Gladys supervisor to the container:
//   - GLADYS_HOST_API_URL         (host API URL)
//   - GLADYS_INTEGRATION_TOKEN    (integration-scoped JWT)
//   - GLADYS_INTEGRATION_SELECTOR (integration identifier)
// The SDK reads them automatically: `new GladysIntegration()` is enough.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';

import { RoborockClient } from './src/xiaomi/client.js';
import { convertDevice, vacuumExternalIds } from './src/devices/convertDevice.js';
import { buildPollStates, buildSetCommand } from './src/devices/vacuum.js';
import { isSessionUsable, readSession, sessionToConfig } from './src/xiaomi/session.js';

const gladys = new GladysIntegration();

// The integration has NO user-facing configuration: the Xiaomi account is
// linked once with the `link_account` action, and the session it yields (plus
// the region, the robots, their local keys and IPs) is discovered and
// remembered. The session lives in off-schema config keys, so a restart never
// needs the interactive link again.
let session = readSession();
let roborock = new RoborockClient(session);

/**
 * Split a device external id (`ext:<selector>:vacuum:<duid>`, built with
 * gladys.externalIds()) into its type slug and Roborock device id.
 * @param {string} externalId the device external id
 * @returns {{ slug: string, duid: string }} the parsed parts
 */
function parseExternalId(externalId) {
  const prefix = gladys.externalId('');
  if (!externalId || !externalId.startsWith(prefix)) {
    throw new Error(
      `Roborock device external_id is invalid: "${externalId}" should start with "${prefix}"`,
    );
  }
  const parts = externalId.slice(prefix.length).split(':');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(
      `Roborock device external_id is invalid: "${externalId}" should be "${prefix}<slug>:<duid>"`,
    );
  }
  return { slug: parts[0], duid: parts[1] };
}

/**
 * Persist the Xiaomi session (off-schema config keys) so the next start
 * reconnects silently, without the interactive account link.
 */
async function persistSession() {
  const current = roborock.getSession();
  if (!current || !isSessionUsable(current)) {
    return;
  }
  session = current;
  try {
    await gladys.setConfig(sessionToConfig(current));
  } catch (err) {
    logger.error('Could not persist the Xiaomi session', err);
  }
}

/**
 * Report the connection as OK. Drives the live badge of the Configuration
 * screen — the user never has to check anything by hand. No message: the green
 * badge says it all, and the robots show up in the Discovery screen.
 */
async function reportConnected() {
  await gladys
    .setConnectionStatus(true)
    .catch((err) => logger.error('Could not report the connection status', err));
}

/**
 * Report the connection as broken. A message is only worth showing when it says
 * something the red badge does not already say (a failure reason, a next step).
 * @param {object} [message] optional multi-language message shown under the badge
 */
async function reportDisconnected(message) {
  await gladys
    .setConnectionStatus(false, message)
    .catch((err) => logger.error('Could not report the connection status', err));
}

/**
 * Reconnect with the linked Xiaomi account (silent passToken login). Returns
 * false (without throwing) when the account has not been linked yet.
 * @returns {Promise<boolean>} whether the connection was attempted and succeeded
 */
async function connectToRoborock() {
  if (!isSessionUsable(session)) {
    await roborock.logout();
    logger.warn('Xiaomi account not linked yet: click Connect in the integration settings');
    // No message: the red badge next to the account already says it, and the
    // field description already explains what the button does.
    await reportDisconnected();
    return false;
  }
  await roborock.logout();
  roborock = new RoborockClient(session);
  try {
    await roborock.login();
  } catch (err) {
    await reportDisconnected({
      en: `Connection failed: ${err.message}`,
      fr: `Échec de la connexion : ${err.message}`,
    });
    throw err;
  }
  await persistSession();
  await reportConnected();
  return true;
}

/**
 * Load the robots from Roborock and publish them as discovered devices.
 */
async function publishDevices() {
  const devices = roborock.listDevices();
  logger.info(`${devices.length} Roborock robot(s) found`);
  await gladys.publishDiscoveredDevices(devices.map((device) => convertDevice(gladys, device)));
}

/**
 * Publish the transport badge (local / cloud) of a device, if known.
 * @param {string} duid the device id
 * @param {string} externalId the device external id
 */
async function publishTransport(duid, externalId) {
  const transport = roborock.getLastTransport(duid);
  if (transport) {
    await gladys.publishTransports([{ external_id: externalId, transport }]);
  }
}

// --- Discovery: Gladys asks for the list of devices --------------------------
gladys.onScanRequest(async () => {
  logger.info('onScanRequest -> loading Roborock devices');
  if (!roborock.isLoggedIn() && !(await connectToRoborock())) {
    throw new Error('Roborock is not configured');
  }
  await publishDevices();
});

// --- Command: the user acts on a controllable feature ------------------------
gladys.onSetValue(async (device, feature, value) => {
  logger.info(`onSetValue <- ${feature.external_id} = ${value}`);
  const { duid } = parseExternalId(device.external_id);
  const featureCode = feature.external_id.split(':').pop();

  const command = buildSetCommand(featureCode, value);
  if (!command) {
    throw new Error(
      `Roborock feature "${feature.external_id}" is not controllable with value ${value}`,
    );
  }
  await roborock.sendCommand(duid, command.method, command.params);
});

// --- Polling: Gladys asks to refresh a device --------------------------------
gladys.onPoll(async (device) => {
  const { duid } = parseExternalId(device.external_id);
  const status = await roborock.getStatus(duid);
  const states = buildPollStates(vacuumExternalIds(gladys, duid), status);
  if (states.length > 0) {
    await gladys.publishStates(states);
  }
  await publishTransport(duid, device.external_id);
});

// --- Linking the Xiaomi account ("Connect" button of the oauth2 field) -------
// Gladys opens the URL we return in the user's browser. It is not a real OAuth2
// provider: it is the Xiaomi QR sign-in page. The user approves it there, and we
// learn about it through the long poll below — Xiaomi redirects to its own STS
// endpoint, never back to Gladys, so no callback is involved.
gladys.onOAuthAuthorizeUrl(async () => {
  logger.info('Connect -> starting the Xiaomi sign-in');
  const { loginUrl } = await roborock.startAccountLink();
  // Watch for the approval in the background: the URL must be returned right
  // away, the user needs the page open BEFORE they can approve anything.
  waitForAccountLink().catch((err) => logger.error('Account link failed', err));
  await reportDisconnected({
    en: 'Sign in on the Xiaomi page that just opened. This screen updates on its own.',
    fr: "Connectez-vous sur la page Xiaomi qui vient de s'ouvrir. Cet écran se met à jour tout seul.",
  });
  return loginUrl;
});

/**
 * Await the approval of a pending account link, then persist the session,
 * publish the robots and report the connection state. Long-polls until the
 * sign-in page expires.
 */
async function waitForAccountLink() {
  while (roborock.hasPendingAccountLink()) {
    const linked = await roborock.pollAccountLink();
    if (linked) {
      logger.info('Xiaomi account linked');
      await persistSession();
      await publishDevices();
      await reportConnected();
      return;
    }
  }
  logger.warn('The Xiaomi account link expired before it was approved');
  await reportDisconnected({
    en: 'The sign-in page expired before it was approved. Click Connect again.',
    fr: "La page de connexion a expiré avant d'être validée. Cliquez à nouveau sur Connecter.",
  });
}

// --- Configuration updated ----------------------------------------------------
// Also fires for OUR OWN setConfig() when the session is persisted, so a
// reconnection is only triggered when the session actually changed — otherwise
// persist -> update -> reconnect -> persist would loop forever.
gladys.onConfigUpdated(async (newConfig) => {
  const updated = readSession(newConfig);
  if (roborock.isLoggedIn() && sameSession(updated, session)) {
    return;
  }
  logger.info('onConfigUpdated -> reconnecting to Roborock');
  session = updated;
  try {
    if (await connectToRoborock()) {
      await publishDevices();
    }
  } catch (err) {
    logger.error('Reconnection to Roborock failed', err);
  }
});

/**
 * Whether two sessions carry the same credentials.
 * @param {object} a first session
 * @param {object} b second session
 * @returns {boolean} true when equivalent
 */
function sameSession(a, b) {
  return (
    Boolean(a) &&
    Boolean(b) &&
    a.userId === b.userId &&
    a.passToken === b.passToken &&
    a.deviceId === b.deviceId
  );
}

// --- Connection lifecycle ----------------------------------------------------
gladys.on('connected', async () => {
  logger.info('WebSocket connected to Gladys');
  try {
    session = readSession(await gladys.getConfig());
    if (await connectToRoborock()) {
      await publishDevices();
    }
  } catch (err) {
    logger.error('Post-connection initialization failed', err);
  }
});

gladys.on('disconnected', () => {
  logger.warn('WebSocket disconnected - the SDK will try to reconnect');
});

// --- Graceful shutdown -------------------------------------------------------
gladys.handleShutdown(async (signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
  await roborock.logout();
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the Roborock integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
