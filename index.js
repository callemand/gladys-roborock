// -----------------------------------------------------------------------------
// Entry point of the Gladys Roborock external integration.
//
//   - controls the robot vacuums of a ROBOROCK app account. A robot paired in the
//     XIAOMI HOME app answers on another cloud entirely and is served by its own
//     integration;
//   - links the account from the email address and the code Roborock sends back:
//     no password, because many accounts simply have none (registered with a
//     code, or through Google/Apple) and those that do may be guarded by two-step
//     validation. The session is then persisted and reused silently;
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

import { convertDevice, vacuumExternalIds } from './src/devices/convertDevice.js';
import { buildPollStates, buildSetCommand } from './src/devices/vacuum.js';
import {
  clearedSessionConfig,
  isSessionUsable,
  readSession,
  sameSession,
  sessionToConfig,
} from './src/session.js';
import { CODE_REFUSED, RoborockAccountClient } from './src/roborock/client.js';

const gladys = new GladysIntegration();

// The only settings: the account email, and the code Roborock emails back. The
// robots, their local keys, their IPs and the region are all discovered. The
// session yielded by the one-time link lives in off-schema config keys, so a
// restart never needs the link again.
let roborockEmail = null;
// Single-use and transient: cleared as soon as it has served.
let roborockCode = null;
let session = readSession();
let roborock = new RoborockAccountClient(session);

/**
 * Split a device external id (`ext:<selector>:vacuum:<duid>`, built with
 * gladys.externalIds()) into its type slug and Roborock device id.
 * @param {string} externalId the device external id
 * @returns {{ slug: string, duid: string }} the parsed parts
 */
function parseExternalId(externalId) {
  const prefix = gladys.externalId('');
  if (!externalId || !externalId.startsWith(prefix)) {
    throw new Error(`Device external_id is invalid: "${externalId}" should start with "${prefix}"`);
  }
  const parts = externalId.slice(prefix.length).split(':');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(
      `Device external_id is invalid: "${externalId}" should be "${prefix}<slug>:<duid>"`,
    );
  }
  return { slug: parts[0], duid: parts[1] };
}

/**
 * Persist the session (off-schema config keys) so the next start reconnects
 * silently, without another code.
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
    logger.error('Could not persist the Roborock session', err);
  }
}

/**
 * Report the connection state. Drives the live badge of the Configuration
 * screen — the user never has to check anything by hand.
 * @param {boolean} connected whether the account is linked
 * @param {object} [message] a multi-language message, only when it adds something
 */
async function reportStatus(connected, message) {
  await gladys
    .setConnectionStatus(connected, message)
    .catch((err) => logger.error('Could not report the connection status', err));
}

/**
 * Turn a login failure into something the user can act on, in their language.
 * @param {Error} err the failure
 * @returns {object} the multi-language message
 */
function describeFailure(err) {
  if (err.reason === CODE_REFUSED) {
    return {
      en: 'That code was refused. A code can only be used once and expires quickly: clear the field, save to get a new one, then enter that one.',
      fr: "Ce code a été refusé. Un code ne sert qu'une fois et expire vite : effacez le champ, enregistrez pour en recevoir un nouveau, puis saisissez celui-là.",
    };
  }
  return {
    en: `Connection failed: ${err.message}`,
    fr: `Échec de la connexion : ${err.message}`,
  };
}

/**
 * Ask Roborock to email a code, and tell the user where to put it.
 * @returns {Promise<object>} the message to show
 */
async function requestCode() {
  try {
    await roborock.requestEmailCode(roborockEmail);
  } catch (err) {
    logger.error('Could not ask Roborock for a code', err);
    return {
      en: `Roborock refused to send a code: ${err.message}`,
      fr: `Roborock a refusé d'envoyer un code : ${err.message}`,
    };
  }
  logger.info(`A code was sent to ${roborockEmail}`);
  return {
    en: `A code has just been sent to ${roborockEmail}: fill it in below and save again.`,
    fr: `Un code vient d'être envoyé à ${roborockEmail} : saisissez-le ci-dessous et enregistrez à nouveau.`,
  };
}

/**
 * Connect the account: reuse the stored session, or link with the code the user
 * filled in. Returns false, without throwing, when there is nothing to work with.
 * @param {boolean} [interactive] true when the user just saved the settings
 * @returns {Promise<boolean>} whether the account is connected
 */
async function connect(interactive = false) {
  await roborock.logout();
  const usable = isSessionUsable(session);
  roborock = new RoborockAccountClient(usable ? session : {});

  if (!usable && !roborockCode) {
    // An email with no code is step one: ask Roborock for a code and say so.
    // Only ever on a save, though — doing it at boot would email the user every
    // time the container restarts.
    if (interactive && roborockEmail) {
      await reportStatus(false, await requestCode());
    } else {
      logger.info('Roborock account not linked yet: fill in your email in the settings');
      await reportStatus(false);
    }
    return false;
  }

  let usedCode = false;
  try {
    if (usable) {
      await roborock.login();
    } else {
      logger.info('Linking the account with the code received by email');
      usedCode = true;
      await roborock.linkWithEmailCode(roborockEmail, roborockCode);
    }
  } catch (err) {
    logger.error('Could not connect the Roborock account', err);
    await reportStatus(false, describeFailure(err));
    return false;
  }
  await persistSession();
  if (usedCode) {
    // single-use: leaving it in the form would have it replayed on the next save
    // and refused, and it is of no use once the session is stored
    roborockCode = null;
    await gladys
      .setConfig({ roborock_code: '' })
      .catch((err) => logger.error('Could not clear the used code', err));
  }
  await reportStatus(true);
  return true;
}

/**
 * Load the robots and publish them as discovered devices.
 */
async function publishDevices() {
  const devices = roborock.listDevices();
  logger.info(`${devices.length} robot vacuum(s) found`);
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
  logger.info('onScanRequest -> loading the robots of the account');
  if (!roborock.isLoggedIn() && !(await connect())) {
    throw new Error('The Roborock account is not linked yet');
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
    throw new Error(`Feature "${feature.external_id}" is not controllable with value ${value}`);
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

// --- Configuration updated ----------------------------------------------------
// The account has no button at all: it is driven entirely by its two fields.
// Saving the email asks for a code; saving the code links; clearing the email
// unlinks.
//
// This also fires for OUR OWN setConfig() when the session is persisted, so a
// reconnection only happens when something actually changed — otherwise
// persist -> update -> reconnect -> persist would loop for ever.
gladys.onConfigUpdated(async (newConfig) => {
  const updated = readSession(newConfig);
  const updatedEmail = newConfig.roborock_email || null;
  const updatedCode = newConfig.roborock_code || null;
  const emailChanged = updatedEmail !== roborockEmail;
  const codeChanged = updatedCode !== roborockCode;
  const sessionChanged = !sameSession(updated, session);
  if (!emailChanged && !codeChanged && !sessionChanged) {
    return;
  }
  roborockEmail = updatedEmail;
  roborockCode = updatedCode;
  session = updated;
  if (emailChanged || (codeChanged && updatedCode)) {
    // Whatever was stored was obtained for the PREVIOUS email, and a code that
    // was just filled in is meant to be used: in both cases start clean.
    //
    // Note the `updatedCode` guard: CLEARING a code that has served also changes
    // it, and reconnecting there would ask Roborock for yet another code — one
    // email per round, for ever.
    session = {};
  } else if (!sessionChanged) {
    return;
  }
  logger.info('onConfigUpdated -> reconnecting');
  try {
    await connect(true);
    await publishDevices();
    if (emailChanged && !roborock.isLoggedIn()) {
      // no stale session may outlive the email that produced it
      session = {};
      await gladys
        .setConfig(clearedSessionConfig())
        .catch((err) => logger.error('Could not clear the session', err));
    }
  } catch (err) {
    logger.error('Reconnection failed', err);
  }
});

// --- Connection lifecycle ----------------------------------------------------
gladys.on('connected', async () => {
  logger.info('WebSocket connected to Gladys');
  try {
    const rawConfig = await gladys.getConfig();
    roborockEmail = rawConfig.roborock_email || null;
    roborockCode = rawConfig.roborock_code || null;
    session = readSession(rawConfig);
    if (await connect()) {
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
