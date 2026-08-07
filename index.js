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

// Nothing is configured through the form: the account is linked by the two
// actions (ask for a code, then send it back), and the robots, their local keys,
// their IPs and the region are all discovered. The email and the session live in
// off-schema config keys, so a restart never needs the link again.
const EMAIL_KEY = 'roborock_email';
// Checked before anything is sent. Gladys has no notion of a field format, so the
// button cannot be greyed out until the address is right — but a malformed one
// must not cost a round trip to Roborock, nor leave the user waiting for an email
// that was never going to arrive. Same shape as an <input type="email"> accepts:
// one @, no whitespace, a dot in the domain. Deliberately permissive — whether
// the address exists is Roborock's business, not ours.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
let roborockEmail = null;
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
 * Connect the account: reuse the stored session, or link with the code the user
 * filled in. Returns false, without throwing, when there is nothing to work with.
 * @returns {Promise<boolean>} whether the account is connected
 */
async function connect() {
  await roborock.logout();
  if (!isSessionUsable(session)) {
    roborock = new RoborockAccountClient({});
    logger.info('Account not linked yet: ask for a code from the integration settings');
    await reportStatus(false);
    return false;
  }
  roborock = new RoborockAccountClient(session);
  try {
    await roborock.login();
  } catch (err) {
    logger.error('Could not connect the Roborock account', err);
    await reportStatus(false, describeFailure(err));
    return false;
  }
  await persistSession();
  await reportStatus(true, linkedMessage());
  return true;
}

/**
 * Which account is linked. The email is no longer a form field, so this is the
 * only place the user can see it — and seeing it is how they notice they linked
 * the wrong address.
 * @returns {object|undefined} the multi-language message
 */
function linkedMessage() {
  if (!roborockEmail) {
    return undefined;
  }
  return {
    en: `Linked account: ${roborockEmail}.`,
    fr: `Compte lié : ${roborockEmail}.`,
  };
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

// --- The two actions that link the account ------------------------------------
// The email and the code are carried by the actions themselves, right above the
// button that uses them: the value travels with the call, so there is no "did you
// save first?" trap, and a malformed address is refused here — before anything is
// sent — rather than leaving the user waiting for an email that never comes.
gladys.onAction('roborock_send_code', async (fields) => {
  const email = ((fields && fields.email) || '').trim();
  if (!email) {
    return {
      en: 'Fill in your account email first.',
      fr: "Renseignez d'abord l'e-mail de votre compte.",
    };
  }
  if (!EMAIL_REGEX.test(email)) {
    return {
      en: `"${email}" is not a valid email address — nothing was sent. Check it and try again.`,
      fr: `« ${email} » n'est pas une adresse e-mail valide — rien n'a été envoyé. Corrigez-la et réessayez.`,
    };
  }
  roborockEmail = email;
  // remembered off-schema: the link below, and every later re-link, needs it
  await gladys
    .setConfig({ [EMAIL_KEY]: email })
    .catch((err) => logger.error('Could not remember the account email', err));
  await roborock.requestEmailCode(email);
  logger.info(`A code was sent to ${email}`);
  return {
    en: `A code has been sent to ${email}. Enter it below, then click "Link the account with this code".`,
    fr: `Un code a été envoyé à ${email}. Saisissez-le ci-dessous, puis cliquez sur « Lier le compte avec ce code ».`,
  };
});

gladys.onAction('roborock_link', async (fields) => {
  const code = ((fields && fields.code) || '').trim();
  if (!code) {
    return { en: 'Enter the code you received.', fr: 'Saisissez le code que vous avez reçu.' };
  }
  if (!roborockEmail) {
    return {
      en: 'Ask for a code first: the address it was sent to is not known yet.',
      fr: "Demandez d'abord un code : l'adresse à laquelle l'envoyer n'est pas encore connue.",
    };
  }
  roborock = new RoborockAccountClient({});
  try {
    await roborock.linkWithEmailCode(roborockEmail, code);
  } catch (err) {
    logger.error('Could not link the Roborock account', err);
    await reportStatus(false, describeFailure(err));
    return describeFailure(err);
  }
  await persistSession();
  await publishDevices();
  await reportStatus(true, linkedMessage());
  const count = roborock.listDevices().length;
  return {
    en: `Account linked, ${count} robot(s) found — open the Discovery screen to add them.`,
    fr: `Compte lié, ${count} robot(s) trouvé(s) — ouvrez l'écran Découverte pour les ajouter.`,
  };
});

gladys.onAction('roborock_unlink', async () => {
  await roborock.logout();
  roborock = new RoborockAccountClient({});
  session = {};
  await gladys
    .setConfig(clearedSessionConfig())
    .catch((err) => logger.error('Could not clear the session', err));
  await publishDevices();
  await reportStatus(false);
  return {
    en: 'The account has been unlinked. Its robots are no longer discovered.',
    fr: 'Le compte a été délié. Ses robots ne sont plus découverts.',
  };
});

// --- Configuration updated ----------------------------------------------------
// Nothing on this screen is a setting any more, so the only thing that can reach
// here is a save of the reserved GLADYS_* preferences. The session is compared
// all the same: a config-updated is cheap to ignore, and reconnecting on one
// would drop a working session for nothing.
gladys.onConfigUpdated(async (newConfig) => {
  const updated = readSession(newConfig);
  if (sameSession(updated, session)) {
    return;
  }
  logger.info('onConfigUpdated -> the stored session changed, reconnecting');
  session = updated;
  try {
    if (await connect()) {
      await publishDevices();
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
    roborockEmail = rawConfig[EMAIL_KEY] || null;
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
