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

import {
  DOCK_SLUG,
  convertDevice,
  convertDockDevice,
  dockExternalIds,
  vacuumExternalIds,
} from './src/devices/convertDevice.js';
import {
  MAP_WIDGET_KEY,
  buildMapWidgetContent,
  duidFromImageKey,
  mapImageKey,
} from './src/devices/mapWidget.js';
import { renderMapPngBase64 } from './src/roborock/mapRender.js';
import {
  buildConsumableStates,
  buildDockStates,
  buildPollStates,
  buildSetCommand,
  routineIdFromFeatureCode,
} from './src/devices/vacuum.js';
import { buildLastCleanStartState, extractLastCleanStart } from './src/devices/lastClean.js';
import {
  SESSION_KEYS,
  clearedSessionConfig,
  isSessionUsable,
  readSession,
  sameSession,
  sessionToConfig,
} from './src/session.js';
import {
  CONSUMABLE_LIFETIME,
  FEATURE_CODES,
  ROBOROCK_CLEANING_STATES,
  ROBOROCK_SEGMENT_CLEANING_STATES,
  ROOM_SELECTION_NONE,
} from './src/constants.js';
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

// Appareils pour lesquels un nettoyage par pièce vient d'être demandé.
// `active` passe à true uniquement après avoir observé un état Roborock
// correspondant réellement à un nettoyage par segment.
const roomCleanings = new Map();

// Permet de remettre à zéro une ancienne sélection après un redémarrage de
// l'intégration, sans effacer une nouvelle sélection avant son démarrage.
const initializedRoomSelectors = new Set();

/**
 * Cleaning-history cache.
 *
 * get_clean_summary is not guaranteed to be supported locally and can therefore
 * use the Roborock cloud. Do not execute it on every Gladys poll.
 *
 * The QV 35A exposes status.last_clean_t, which corresponds to the end of the
 * latest cleaning. We use it only as a change marker: the actual feature exposed
 * to Gladys is the cleaning START timestamp from get_clean_summary.records[0].
 */
const cleanHistoryCache = new Map();

const CLEAN_HISTORY_REFRESH_MS = 5 * 60 * 1000;

/**
 * Build the room selector feedback produced by a robot status change.
 *
 * The selector is reset only after a segment cleaning has actually been
 * observed and the robot has subsequently left every segment-cleaning state.
 *
 * @param {string} duid Roborock device id
 * @param {object} ids Gladys external ids
 * @param {object} status get_status result
 * @param {boolean} hasRoomSelector whether the robot exposes rooms
 * @returns {object|null} Gladys text state to publish
 */
function buildRoomSelectionFeedback(duid, ids, status, hasRoomSelector) {
  if (!hasRoomSelector) {
    return null;
  }

  const roborockState = Number(status && status.state);
  const isSegmentCleaning = ROBOROCK_SEGMENT_CLEANING_STATES.has(roborockState);

  const trackedCleaning = roomCleanings.get(duid);

  if (isSegmentCleaning) {
    roomCleanings.set(duid, {
      active: true,
    });

    initializedRoomSelectors.add(duid);

    return null;
  }

  const shouldReset = trackedCleaning?.active === true || !initializedRoomSelectors.has(duid);

  initializedRoomSelectors.add(duid);

  if (!shouldReset) {
    return null;
  }

  roomCleanings.delete(duid);

  return {
    device_feature_external_id: ids.feature(FEATURE_CODES.ROOM),
    text: ROOM_SELECTION_NONE,
  };
}

/**
 * Get the latest cleaning start timestamp while limiting history RPC traffic.
 *
 * Verified on Roborock QV 35A (roborock.vacuum.a168):
 *
 *   get_clean_summary.records[0] = get_clean_record(...)[0].begin
 *   get_status.last_clean_t       = get_clean_record(...)[0].end
 *
 * last_clean_t is therefore only used as a cheap change detector.
 *
 * On models that do not expose last_clean_t, the summary is refreshed
 * periodically instead.
 *
 * @param {string} duid Roborock device id
 * @param {object} status get_status result
 * @returns {Promise<number|null>} Unix timestamp in seconds
 */
async function getLastCleanStartForPoll(duid, status) {
  const rawLastCleanEnd = Number(status?.last_clean_t);
  const lastCleanEnd =
    Number.isSafeInteger(rawLastCleanEnd) && rawLastCleanEnd > 0 ? rawLastCleanEnd : null;

  const now = Date.now();
  const cached = cleanHistoryCache.get(duid);

  const roborockState = Number(status?.state);
  const isCleaning = ROBOROCK_CLEANING_STATES.has(roborockState);
  const cleaningStarted = isCleaning && cached?.wasCleaning === false;

  const markerChanged =
    lastCleanEnd !== null &&
    cached?.lastCleanEnd !== undefined &&
    lastCleanEnd !== cached.lastCleanEnd;

  const periodicRefreshDue = !cached || now >= (cached.nextRefreshAt || 0);

  // Refresh immediately when a cleaning starts, and again when last_clean_t
  // changes (normally when that cleaning ends). This makes Last clean start
  // useful while a cleaning is still in progress instead of only afterwards.
  if (!cleaningStarted && !markerChanged && !periodicRefreshDue) {
    if (cached) {
      cached.wasCleaning = isCleaning;
    }
    return cached?.lastCleanStart ?? null;
  }

  try {
    const summary = await roborock.getCleanSummary(duid);
    const lastCleanStart = extractLastCleanStart(summary);

    cleanHistoryCache.set(duid, {
      lastCleanEnd,
      lastCleanStart,
      wasCleaning: isCleaning,
      nextRefreshAt:
        lastCleanEnd === null ? now + CLEAN_HISTORY_REFRESH_MS : Number.POSITIVE_INFINITY,
    });

    return lastCleanStart;
  } catch (err) {
    logger.warn(`Could not get cleaning history for ${duid}: ${err.message}`);

    cleanHistoryCache.set(duid, {
      lastCleanEnd: cached?.lastCleanEnd ?? lastCleanEnd,
      lastCleanStart: cached?.lastCleanStart ?? null,
      wasCleaning: isCleaning,
      nextRefreshAt: now + CLEAN_HISTORY_REFRESH_MS,
    });

    return cached?.lastCleanStart ?? null;
  }
}

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
      en: 'That code was refused. A code can only be used once and expires quickly: ask for a new one and enter that one.',
      fr: "Ce code a été refusé. Un code ne sert qu'une fois et expire vite : demandez-en un nouveau et saisissez celui-là.",
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
    // The deviceId is carried over even with no session: a code already sent was
    // issued for it, and drawing a new one here would refuse that code (2018).
    roborock = new RoborockAccountClient({ deviceId: session.deviceId });
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
  const discovered = [];

  for (const device of devices) {
    discovered.push(convertDevice(gladys, device));
    try {
      const status = await roborock.getStatus(device.duid);
      const dockType = Number(status && status.dock_type);
      if (Number.isFinite(dockType) && dockType > 0) {
        discovered.push(convertDockDevice(gladys, device, dockType));
      }
    } catch (err) {
      logger.warn(`Could not detect a dock for ${device.duid}: ${err.message}`);
    }
  }

  logger.info(
    `${devices.length} robot vacuum(s) and ${discovered.length - devices.length} dock(s) found`,
  );
  await gladys.publishDiscoveredDevices(discovered);
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

  // L’option vide efface seulement la sélection. Le nettoyage complet reste
  // exclusivement piloté par le mode de fonctionnement.
  if (featureCode === FEATURE_CODES.ROOM && value === ROOM_SELECTION_NONE) {
    roomCleanings.delete(duid);
    initializedRoomSelectors.add(duid);
    return;
  }

  const routineId = routineIdFromFeatureCode(featureCode);
  if (routineId !== null) {
    // A push button only has an actionable pressed state. Ignore its release
    // if a client happens to send one, so a click can never run twice.
    if (Number(value) !== 1) {
      return;
    }
    await roborock.executeRoutine(routineId);
    return;
  }

  const command = buildSetCommand(featureCode, value);
  if (!command) {
    throw new Error(`Feature "${feature.external_id}" is not controllable with value ${value}`);
  }
  await roborock.sendCommand(duid, command.method, command.params);

  if (featureCode === FEATURE_CODES.ROOM) {
    // La commande a été acceptée, mais le robot n’est peut-être pas encore
    // passé en état segment_cleaning. Le prochain poll ne doit donc pas
    // réinitialiser immédiatement le sélecteur.
    roomCleanings.set(duid, {
      active: false,
    });

    initializedRoomSelectors.add(duid);
  }
});

// --- Polling: Gladys asks to refresh a device --------------------------------
gladys.onPoll(async (device) => {
  const { slug, duid } = parseExternalId(device.external_id);
  let states;

  if (slug === DOCK_SLUG) {
    const consumable = await roborock.getConsumable(duid);
    states = buildDockStates(dockExternalIds(gladys, duid), consumable);
  } else {
    const [status, consumable] = await Promise.all([
      roborock.getStatus(duid),
      roborock.getConsumable(duid).catch((err) => {
        logger.warn(`Could not get consumables for ${duid}: ${err.message}`);
        return null;
      }),
    ]);
    const ids = vacuumExternalIds(gladys, duid);
    states = [...buildPollStates(ids, status), ...buildConsumableStates(ids, consumable)];

    const lastCleanStart = await getLastCleanStartForPoll(duid, status);
    const lastCleanState = buildLastCleanStartState(ids, lastCleanStart);

    if (lastCleanState) {
      states.push(lastCleanState);
    }

    const robot = roborock.listDevices().find((candidate) => candidate.duid === duid);
    const roomSelectionFeedback = buildRoomSelectionFeedback(
      duid,
      ids,
      status,
      Boolean(robot?.rooms?.length),
    );

    if (roomSelectionFeedback) {
      states.push(roomSelectionFeedback);
    }
  }

  if (states.length > 0) {
    await gladys.publishStates(states);
  }
  await publishTransport(duid, device.external_id);
});

// --- Map dashboard widget ----------------------------------------------------
// The map is exposed as a dashboard widget (SDK >= 0.14), not a device: Gladys
// pulls the content (onWidgetGet) and the image bytes (onWidgetGetImage). A small
// cache holds the last rendered PNG per image key so the two calls of one refresh
// do not fetch the map twice; on a cold cache the duid is recovered from the key.
const MAP_IMAGE_CACHE_MAX = 8;
const mapImageCache = new Map(); // imageKey -> PNG base64

function cacheMapImage(key, base64) {
  mapImageCache.set(key, base64);
  while (mapImageCache.size > MAP_IMAGE_CACHE_MAX) {
    mapImageCache.delete(mapImageCache.keys().next().value);
  }
}

async function renderMapForDuid(duid) {
  if (!roborock.isLoggedIn() && !(await connect())) {
    throw new Error('The Roborock account is not linked yet');
  }
  const map = await roborock.getMap(duid, { includePixels: true });
  return { map, base64: renderMapPngBase64(map) };
}

/**
 * Remaining life as a percentage from a used-seconds counter and its lifetime.
 * @param {number} used seconds of wear
 * @param {number} lifetime total lifetime in seconds
 * @returns {number|null} 0-100, or null when unknown
 */
function remaining(used, lifetime) {
  if (!Number.isFinite(Number(used))) {
    return null;
  }
  return Math.max(0, Math.min(100, 100 - (Number(used) / lifetime) * 100));
}

/**
 * Remaining life of every tracked consumable, in percent.
 * @param {object} c the get_consumable result
 * @returns {object} { mainBrush, sideBrush, filter, sensor }
 */
function consumablePercents(c) {
  const v = c || {};
  return {
    mainBrush: remaining(v.main_brush_work_time, CONSUMABLE_LIFETIME.MAIN_BRUSH_SECONDS),
    sideBrush: remaining(v.side_brush_work_time, CONSUMABLE_LIFETIME.SIDE_BRUSH_SECONDS),
    filter: remaining(v.filter_work_time, CONSUMABLE_LIFETIME.FILTER_SECONDS),
    sensor: remaining(v.sensor_dirty_time, CONSUMABLE_LIFETIME.SENSOR_SECONDS),
  };
}

gladys.onWidgetGet(MAP_WIDGET_KEY, async ({ settings }) => {
  const vacuumExternalId = settings && settings.vacuum;
  if (!vacuumExternalId) {
    throw new Error('No vacuum selected for the map widget');
  }
  const { duid } = parseExternalId(vacuumExternalId);
  logger.info(`onWidgetGet(map) <- ${duid}`);
  const { map, base64 } = await renderMapForDuid(duid);
  const imageKey = mapImageKey(duid, map.mapSequence);
  cacheMapImage(imageKey, base64);
  // The map image is ready; gather the live numbers for the tiles / status block.
  const [status, consumables] = await Promise.all([
    roborock.getStatus(duid).catch((err) => {
      logger.warn(`Widget: could not get status for ${duid}: ${err.message}`);
      return {};
    }),
    roborock
      .getConsumable(duid)
      .then((c) => consumablePercents(c))
      .catch(() => ({})),
  ]);
  await publishTransport(duid, vacuumExternalId);
  return buildMapWidgetContent(map, { imageKey, vacuumExternalId, status, consumables, settings });
});

gladys.onWidgetGetImage(async (imageKey) => {
  const cached = mapImageCache.get(imageKey);
  if (cached) {
    return cached;
  }
  const duid = duidFromImageKey(imageKey);
  if (!duid) {
    throw new Error(`Unknown map image key: ${imageKey}`);
  }
  logger.info(`onWidgetGetImage <- re-rendering ${duid} (cache miss)`);
  const { base64 } = await renderMapForDuid(duid);
  cacheMapImage(imageKey, base64);
  return base64;
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
  // Remembered off-schema, together with the deviceId: Roborock issues the code
  // for a `header_clientid` derived from (email, deviceId), so the link step MUST
  // present the same one or the code is refused (2018). Persisting it is what
  // makes the two steps survive a restart of the container in between.
  await gladys
    .setConfig({ [EMAIL_KEY]: email, [SESSION_KEYS.DEVICE_ID]: roborock.getSession().deviceId })
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
  // The client is NOT recreated here: it carries the deviceId the code was issued
  // for. Building a fresh one drew a new random deviceId, so the code came back
  // refused with 2018 every time — the bug this replaces.
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

// --- Resilience --------------------------------------------------------------
// A long-running integration must never die on a stray async error (e.g. a local
// transport socket rejected a pending request as it was torn down during a cloud
// fallback). Log and keep running: the SDK reconnects, and the next poll / widget
// pull succeeds over the cloud. Without this, an unhandled rejection exits the
// process and Gladys shows the integration as degraded.
process.on('unhandledRejection', (reason) => {
  logger.warn(
    `Unhandled promise rejection (ignored): ${reason && reason.message ? reason.message : reason}`,
  );
});
process.on('uncaughtException', (err) => {
  logger.error(`Uncaught exception (ignored): ${err && err.message ? err.message : err}`);
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the Roborock integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
