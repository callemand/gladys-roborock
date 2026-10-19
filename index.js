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

import { createHash } from 'node:crypto';

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';

import {
  DOCK_SLUG,
  convertDevice,
  convertDockDevice,
  dockExternalIds,
  vacuumExternalIds,
} from './src/devices/convertDevice.js';
import {
  FAN_POWER_WIDGET_ACTION,
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
  buildSegmentCleanCommand,
  buildSetCommand,
  consumablePercents,
  routineIdFromFeatureCode,
} from './src/devices/vacuum.js';
import {
  buildCleanedTodayState,
  buildLastCleanStartState,
  extractLastCleanStart,
} from './src/devices/lastClean.js';
import { computeSceneEvents, snapshotFromStatus } from './src/devices/sceneTriggers.js';
import {
  FAN_POWER_MODES,
  SCENE_ACTIONS,
  resolveRoomSegments,
  resolveRoutineId,
} from './src/devices/sceneActions.js';
import {
  SESSION_KEYS,
  clearedSessionConfig,
  isSessionUsable,
  readSession,
  sameSession,
  sessionToConfig,
} from './src/session.js';
import {
  FEATURE_CODES,
  ROBOROCK_CLEANING_STATES,
  ROBOROCK_METHOD,
  ROBOROCK_SEGMENT_CLEANING_STATES,
  ROBOROCK_STATE,
  ROBOROCK_WATER_BOX_MODE,
  ROOM_SELECTION_NONE,
  VACUUM_CLEANER_MODE,
  describeState,
} from './src/constants.js';
import { CODE_REFUSED, DEVICES_LOAD_FAILED, RoborockAccountClient } from './src/roborock/client.js';
import { IOT_SIGNATURE_REFUSED } from './src/roborock/restClient.js';

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
// whether the broker refusal was reported, so its recovery is reported too
let cloudRefused = false;
// The one setting Gladys itself renders, because the manifest declares both
// the local and the cloud transports: the reserved, read-only key
// GLADYS_PREFER_LOCAL ("Prefer the local connection", true unless turned off).
let preferLocal = true;
let roborock = newRoborockClient(session);

/**
 * Read the user's transport preference from the integration config.
 * @param {Record<string, unknown>} config the config returned by Gladys
 * @returns {boolean} false only when the user turned the toggle off
 */
function readPreferLocal(config = {}) {
  return config.GLADYS_PREFER_LOCAL !== false;
}

// Appareils pour lesquels un nettoyage par pièce vient d'être demandé.
// `active` passe à true uniquement après avoir observé un état Roborock
// correspondant réellement à un nettoyage par segment.
const roomCleanings = new Map();

// Permet de remettre à zéro une ancienne sélection après un redémarrage de
// l'intégration, sans effacer une nouvelle sélection avant son démarrage.
const initializedRoomSelectors = new Set();

// Pièce (segment) actuellement choisie dans le sélecteur Gladys, par robot :
// « Nettoyage » dans le mode de fonctionnement nettoie alors cette pièce au
// lieu de lancer un nettoyage complet (issue #13).
const selectedRooms = new Map();

// Last status seen per robot (poll, widget, command) and the last non-off water
// flow it reported: both feed the clean-mode commands of mop-capable robots
// (see buildSetCommand), which keep the robot's own suction and water settings.
const lastStatuses = new Map();
const lastWaterBoxModes = new Map();

function rememberStatus(duid, status) {
  if (!status || typeof status !== 'object') {
    return;
  }
  lastStatuses.set(duid, status);
  const waterBoxMode = Number(status.water_box_mode);
  if (Number.isFinite(waterBoxMode) && waterBoxMode !== ROBOROCK_WATER_BOX_MODE.OFF) {
    lastWaterBoxModes.set(duid, waterBoxMode);
  }
}

/**
 * The current status of a robot, fetched right before a command (a poll is up
 * to 30 s old). Falls back to the last known status when the robot does not
 * answer, so the command still goes out.
 * @param {string} duid the Roborock device id
 * @returns {Promise<object>} the status (possibly empty)
 */
async function currentStatus(duid) {
  try {
    const status = await roborock.getStatus(duid);
    rememberStatus(duid, status);
    return status || {};
  } catch (err) {
    logger.warn(`Could not refresh the status of ${duid} before the command: ${err.message}`);
    return lastStatuses.get(duid) || {};
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// A robot busy with a cleaning ignores app_segment_clean: it is stopped first,
// and gets a moment to settle before the new job is sent.
const STOP_BEFORE_SEGMENT_CLEAN_MS = 1500;

// Dernier instantané (snapshot) connu par robot, pour détecter les transitions
// qui déclenchent les scènes. La première observation ne fait qu'amorcer le
// cache : aucun événement n'est émis au démarrage de l'intégration.
const sceneSnapshots = new Map();

// Robots with a cleaning session in progress: the map widget is refreshed faster
// (and cached more briefly) for them, so the map is near real-time while cleaning.
const cleaningDuids = new Set();

/**
 * Detect the robot transitions since the last poll and fire the matching scene
 * triggers. Never throws: a trigger failure must not break the poll.
 * @param {object} device the Gladys device being polled
 * @param {string} duid the Roborock device id
 * @param {object} status the get_status result
 * @param {object} consumable the get_consumable result
 * @returns {Promise<void>}
 */
async function publishSceneTriggers(device, duid, status, consumable) {
  try {
    const snapshot = snapshotFromStatus(status, consumablePercents(consumable));
    const previous = sceneSnapshots.get(duid) || null;
    sceneSnapshots.set(duid, snapshot);

    const events = computeSceneEvents(previous, snapshot, {
      vacuum: device.external_id,
      deviceName: device.name || duid,
    });
    for (const event of events) {
      await gladys.publishSceneEvent(event.key, event.data);
    }

    for (const event of events) {
      logger.info(`Scene trigger ${event.key} fired for ${duid}`);
    }

    if (snapshot.sessionActive && !cleaningDuids.has(duid)) {
      logger.info(
        `${duid}: cleaning session started, map refreshed every ${MAP_LIVE_REFRESH_MS / 1000} s`,
      );
      cleaningDuids.add(duid);
    } else if (!snapshot.sessionActive && cleaningDuids.has(duid)) {
      logger.info(`${duid}: cleaning session over, map back to the normal refresh rate`);
      cleaningDuids.delete(duid);
    }
  } catch (err) {
    logger.warn(`Could not publish scene triggers for ${duid}: ${err.message}`);
  }
}

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

  logger.info(
    `${duid}: room selector reset (${
      trackedCleaning?.active ? 'the room cleaning is over' : 'integration start'
    }, state ${describeState(roborockState)})`,
  );
  roomCleanings.delete(duid);

  return {
    device_feature_external_id: ids.feature(FEATURE_CODES.ROOM),
    text: ROOM_SELECTION_NONE,
  };
}

// Last state logged per robot: a state change is worth its own line.
const lastLoggedStates = new Map();

/**
 * One log line per poll with what matters when diagnosing a cleaning (state,
 * error, modes, progress), plus a dedicated line when the state changes.
 * @param {string} duid the Roborock device id
 * @param {object} status the get_status result
 */
function logPolledStatus(duid, status) {
  const s = status || {};
  const state = Number(s.state);
  const previous = lastLoggedStates.get(duid);
  if (previous !== undefined && previous !== state) {
    logger.info(`${duid}: state ${describeState(previous)} -> ${describeState(state)}`);
  }
  lastLoggedStates.set(duid, state);
  logger.info(
    `poll ${duid}: state=${describeState(state)} error=${s.error_code ?? '-'} ` +
      `in_cleaning=${s.in_cleaning ?? '-'} in_returning=${s.in_returning ?? '-'} ` +
      `fan=${s.fan_power ?? '-'} water=${s.water_box_mode ?? '-'} route=${s.mop_mode ?? '-'} ` +
      `battery=${s.battery ?? '-'} clean_time=${s.clean_time ?? '-'}s clean_area=${
        s.clean_area !== undefined ? Math.round(Number(s.clean_area) / 1e6) : '-'
      }m² map_status=${s.map_status ?? '-'} dock_error=${s.dock_error_status ?? '-'}`,
  );
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

    // Store the CURRENT lastCleanEnd (not the stale cached one) so a model that
    // does not support get_clean_summary — or an unreachable cloud — does not
    // keep `markerChanged` true and retry the (possibly 15s-timeout) call on
    // every 30s poll. The periodic refresh (nextRefreshAt) still applies.
    cleanHistoryCache.set(duid, {
      lastCleanEnd,
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
 * A Roborock client wired to the connection badge.
 * @param {object} clientSession the session to start from
 * @returns {RoborockAccountClient} the client
 */
function newRoborockClient(clientSession) {
  return new RoborockAccountClient(clientSession, { onCloudStatus, preferLocal });
}

/**
 * Follow the cloud connection once the account is linked. The broker refuses a
 * client it considers abusive the same way as revoked credentials, and lifts it
 * after a while: the transport keeps retrying (hourly), the user is only told
 * what is going on, and what to do if it lasts.
 * @param {string} status 'connected' or 'unauthorized'
 */
function onCloudStatus(status) {
  if (status === 'unauthorized') {
    cloudRefused = true;
    reportStatus(false, {
      en: 'Roborock refuses the cloud connection. The integration retries every hour on its own; if it lasts, ask for a new code and link the account again.',
      fr: "Roborock refuse la connexion au cloud. L'intégration réessaie d'elle-même toutes les heures ; si cela dure, demandez un nouveau code et liez à nouveau le compte.",
    });
  } else if (status === 'connected' && cloudRefused) {
    cloudRefused = false;
    reportStatus(true, linkedMessage());
  }
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
  if (err.reason === DEVICES_LOAD_FAILED && err.cause?.reason === IOT_SIGNATURE_REFUSED) {
    return {
      en:
        'The account is linked, but Roborock refuses the signed requests (HTTP 401). This nearly always means the clock of ' +
        'the machine running Gladys is wrong: synchronise it (NTP), then restart the integration. No new code is needed.',
      fr:
        'Le compte est lié, mais Roborock refuse les requêtes signées (HTTP 401). Cela vient presque toujours de ' +
        "l'horloge de la machine qui fait tourner Gladys : synchronisez-la (NTP), puis redémarrez l'intégration. " +
        'Aucun nouveau code n’est nécessaire.',
    };
  }
  if (err.reason === DEVICES_LOAD_FAILED) {
    return {
      en: `The account is linked, but the robots could not be loaded: ${err.cause?.message || err.message}. The integration retries by itself; no new code is needed.`,
      fr: `Le compte est lié, mais les robots n'ont pas pu être chargés : ${err.cause?.message || err.message}. L'intégration réessaie d'elle-même ; aucun nouveau code n'est nécessaire.`,
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
    roborock = newRoborockClient({ deviceId: session.deviceId });
    logger.info('Account not linked yet: ask for a code from the integration settings');
    await reportStatus(false);
    return false;
  }
  roborock = newRoborockClient(session);
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
    // The status tells whether the robot mops (which clean modes to offer) and
    // whether it has a dock. Without it the robot is published as suction-only;
    // the next publication corrects the options (the core upserts them).
    let status = null;
    try {
      status = await roborock.getStatus(device.duid);
      rememberStatus(device.duid, status);
    } catch (err) {
      logger.warn(`Could not get the status of ${device.duid}: ${err.message}`);
    }
    discovered.push(convertDevice(gladys, device, status));
    const dockType = Number(status && status.dock_type);
    if (Number.isFinite(dockType) && dockType > 0) {
      discovered.push(convertDockDevice(gladys, device, dockType));
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
  if (roborock.listDevices().length === 0) {
    // Linked, but the robots were never loaded (the link ended on a load
    // failure, see roborock_link): a scan is the user's way to try again.
    await roborock.login();
    await reportStatus(true, linkedMessage());
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
    selectedRooms.delete(duid);
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

  // These commands depend on what the robot is doing right now (and, for the
  // clean mode, on what it is): ask it rather than trust a 30 s old poll.
  const needsStatus = [FEATURE_CODES.RUN_MODE, FEATURE_CODES.CLEAN_MODE, FEATURE_CODES.ROOM];
  const status = needsStatus.includes(featureCode) ? await currentStatus(duid) : {};
  const roborockState = Number(status.state);
  const isCleaning = ROBOROCK_CLEANING_STATES.has(roborockState);
  if (needsStatus.includes(featureCode)) {
    logger.info(
      `${duid} before the command: state ${describeState(roborockState)}, ` +
        `selected room ${selectedRooms.get(duid) ?? 'none'}, ` +
        `tracked room cleaning ${roomCleanings.has(duid) ? 'yes' : 'no'}`,
    );
  }

  if (featureCode === FEATURE_CODES.RUN_MODE && Number(value) === VACUUM_CLEANER_MODE.CLEANING) {
    // "Cleaning" with a room selected cleans THAT room. Sent as app_start it
    // would start a full cleaning instead — the Saros of issue #13 then showed
    // "full cleaning" while the selector still named a room.
    if (isCleaning) {
      logger.info(`${duid} is already cleaning: nothing to start`);
      return;
    }
    const selectedRoom = selectedRooms.get(duid);
    if (roborockState === ROBOROCK_STATE.PAUSED && roomCleanings.has(duid)) {
      await roborock.sendCommand(duid, ROBOROCK_METHOD.RESUME_SEGMENT_CLEAN, []);
      return;
    }
    if (selectedRoom !== undefined) {
      await startSegmentCleaning(duid, [selectedRoom]);
      return;
    }
    await roborock.sendCommand(duid, ROBOROCK_METHOD.APP_START, []);
    return;
  }

  if (featureCode === FEATURE_CODES.ROOM) {
    const segmentId = Number(value);
    if (!Number.isSafeInteger(segmentId) || segmentId < 0) {
      throw new Error(`Feature "${feature.external_id}" is not controllable with value ${value}`);
    }
    selectedRooms.set(duid, segmentId);
    if (isCleaning) {
      // The robot ignores a room request while a cleaning runs (it kept going
      // on the room of the PREVIOUS selection in issue #13): stop it first.
      logger.info(`${duid} is cleaning: stopping it before cleaning room ${segmentId}`);
      await roborock.sendCommand(duid, ROBOROCK_METHOD.APP_STOP, []);
      await sleep(STOP_BEFORE_SEGMENT_CLEAN_MS);
    }
    await startSegmentCleaning(duid, [segmentId]);
    return;
  }

  const command = buildSetCommand(featureCode, value, {
    status,
    waterBoxMode: lastWaterBoxModes.get(duid),
  });
  if (!command) {
    throw new Error(`Feature "${feature.external_id}" is not controllable with value ${value}`);
  }
  await roborock.sendCommand(duid, command.method, command.params);
});

/**
 * Start a cleaning of the given segments and track it, so the room selector is
 * only reset once that cleaning has been seen running and is over.
 * @param {string} duid the Roborock device id
 * @param {Array<number>} segments the segment ids
 */
async function startSegmentCleaning(duid, segments) {
  const command = buildSegmentCleanCommand(segments);
  await roborock.sendCommand(duid, command.method, command.params);
  // La commande a été acceptée, mais le robot n’est peut-être pas encore
  // passé en état segment_cleaning. Le prochain poll ne doit donc pas
  // réinitialiser immédiatement le sélecteur.
  roomCleanings.set(duid, { active: false });
  initializedRoomSelectors.add(duid);
}

// --- Scene actions: a scene commands the robot -------------------------------
// Each action carries a `vacuum` field (source: "devices"): its value is the
// device external_id, from which the duid is parsed.
function sceneActionDuid(fields) {
  const vacuum = fields && fields.vacuum;
  if (typeof vacuum !== 'string' || !vacuum) {
    throw new Error('The "vacuum" field is required');
  }
  return parseExternalId(vacuum).duid;
}

gladys.onSceneAction(SCENE_ACTIONS.START_CLEANING, async (fields) => {
  await roborock.sendCommand(sceneActionDuid(fields), ROBOROCK_METHOD.APP_START, []);
});

gladys.onSceneAction(SCENE_ACTIONS.PAUSE_CLEANING, async (fields) => {
  await roborock.sendCommand(sceneActionDuid(fields), ROBOROCK_METHOD.APP_PAUSE, []);
});

gladys.onSceneAction(SCENE_ACTIONS.STOP_CLEANING, async (fields) => {
  await roborock.sendCommand(sceneActionDuid(fields), ROBOROCK_METHOD.APP_STOP, []);
});

gladys.onSceneAction(SCENE_ACTIONS.RETURN_TO_DOCK, async (fields) => {
  await roborock.sendCommand(sceneActionDuid(fields), ROBOROCK_METHOD.APP_CHARGE, []);
});

gladys.onSceneAction(SCENE_ACTIONS.SET_FAN_POWER, async (fields) => {
  const duid = sceneActionDuid(fields);
  const cleanMode = FAN_POWER_MODES[String(fields.mode)];
  if (cleanMode === undefined) {
    throw new Error(`Unknown fan power mode: "${fields.mode}"`);
  }
  // A suction level, whatever the robot: the clean-mode mapping of the
  // suction-only robots (no status passed) is exactly that.
  const command = buildSetCommand(FEATURE_CODES.CLEAN_MODE, cleanMode);
  if (!command) {
    throw new Error(`Fan power mode "${fields.mode}" is not controllable`);
  }
  await roborock.sendCommand(duid, command.method, command.params);
});

gladys.onSceneAction(SCENE_ACTIONS.CLEAN_ROOMS, async (fields) => {
  const duid = sceneActionDuid(fields);
  const robot = roborock.listDevices().find((candidate) => candidate.duid === duid);
  const segments = resolveRoomSegments(fields.rooms, robot?.rooms || []);
  if (segments.length === 0) {
    throw new Error(`No known room matched "${fields.rooms}"`);
  }
  await startSegmentCleaning(duid, segments);
});

gladys.onSceneAction(SCENE_ACTIONS.RUN_ROUTINE, async (fields) => {
  const duid = sceneActionDuid(fields);
  const robot = roborock.listDevices().find((candidate) => candidate.duid === duid);
  const routineId = resolveRoutineId(fields.routine, robot?.routines || []);
  if (routineId === null) {
    throw new Error(`No known routine matched "${fields.routine}"`);
  }
  await roborock.executeRoutine(routineId);
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
    rememberStatus(duid, status);
    logPolledStatus(duid, status);
    const ids = vacuumExternalIds(gladys, duid);
    states = [...buildPollStates(ids, status), ...buildConsumableStates(ids, consumable)];

    const lastCleanStart = await getLastCleanStartForPoll(duid, status);
    const lastCleanState = buildLastCleanStartState(ids, lastCleanStart);

    if (lastCleanState) {
      states.push(lastCleanState);
    }

    // "Cleaned today" (0/1): a scene condition can check whether the vacuum ran
    // today. Always published (even 0) so both branches of the condition work.
    states.push(buildCleanedTodayState(ids, lastCleanStart));

    const robot = roborock.listDevices().find((candidate) => candidate.duid === duid);
    const roomSelectionFeedback = buildRoomSelectionFeedback(
      duid,
      ids,
      status,
      Boolean(robot?.rooms?.length),
    );

    if (roomSelectionFeedback) {
      // the selector goes back to "—": the room is no longer selected
      selectedRooms.delete(duid);
      states.push(roomSelectionFeedback);
    }

    await publishSceneTriggers(device, duid, status, consumable);
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

// Short-lived parsed-map + PNG cache per robot, with in-flight de-duplication.
// Without it every dashboard refresh (content ttl) and every image cache-miss
// would fire a fresh get_map_v1 (up to 10s local + 10s cloud) plus a synchronous
// PNG render, and concurrent viewers of the same robot would arm overlapping 301
// waiters (AES "bad decrypt"). A single in-flight request is shared, and its
// result is reused for a short window.
const MAP_RENDER_TTL_MS = 60 * 1000;
// While a cleaning session is active the map is cached only briefly, so the live
// refresh nudge (see below) actually produces an up-to-date render each time.
const MAP_RENDER_TTL_ACTIVE_MS = 8 * 1000;
// How often to nudge a refresh of open map widgets while a robot is cleaning.
const MAP_LIVE_REFRESH_MS = 15 * 1000;
const mapRenderCache = new Map(); // duid -> { at, map, base64, imageKey }
const mapRenderInFlight = new Map(); // duid -> Promise<{ map, base64, imageKey }>

// Short, stable marker of the rendered image: the image key changes (and the core
// swaps the <img>) only when these bytes change, so an unchanged map never flashes.
function mapSignature(base64) {
  return createHash('sha1').update(base64).digest('hex').slice(0, 10);
}

async function renderMapForDuid(duid) {
  const ttl = cleaningDuids.has(duid) ? MAP_RENDER_TTL_ACTIVE_MS : MAP_RENDER_TTL_MS;
  const cached = mapRenderCache.get(duid);
  if (cached && Date.now() - cached.at < ttl) {
    return cached;
  }
  const pending = mapRenderInFlight.get(duid);
  if (pending) {
    return pending;
  }
  const promise = (async () => {
    if (!roborock.isLoggedIn() && !(await connect())) {
      throw new Error('The Roborock account is not linked yet');
    }
    const startedAt = Date.now();
    logger.debug(`Fetching the map of ${duid} (cache ttl ${ttl / 1000} s expired)`);
    const map = await roborock.getMap(duid, { includePixels: true });
    const base64 = renderMapPngBase64(map);
    const imageKey = mapImageKey(duid, mapSignature(base64));
    logger.debug(
      `Map of ${duid} rendered in ${Date.now() - startedAt} ms: ${map.segments?.length ?? 0} segments, ` +
        `${map.namedSegmentCount ?? 0} named, key ${imageKey}`,
    );
    cacheMapImage(imageKey, base64);
    const entry = { at: Date.now(), map, base64, imageKey };
    mapRenderCache.set(duid, entry);
    return entry;
  })();
  mapRenderInFlight.set(duid, promise);
  try {
    return await promise;
  } finally {
    mapRenderInFlight.delete(duid);
  }
}

// Near real-time map while cleaning: drop the cached widget content so every open
// map widget re-pulls (and re-renders) on a short cadence. The core rate-limits
// requestWidgetRefresh to 1/10s, and it is a no-op when no widget is open.
const mapLiveRefresh = setInterval(() => {
  if (cleaningDuids.size === 0) {
    return;
  }
  try {
    gladys.requestWidgetRefresh(MAP_WIDGET_KEY);
  } catch (err) {
    logger.warn(`Map live refresh nudge failed: ${err.message}`);
  }
}, MAP_LIVE_REFRESH_MS);
if (typeof mapLiveRefresh.unref === 'function') {
  mapLiveRefresh.unref();
}

gladys.onWidgetGet(MAP_WIDGET_KEY, async ({ settings, language }) => {
  const vacuumExternalId = settings && settings.vacuum;
  if (!vacuumExternalId) {
    throw new Error('No vacuum selected for the map widget');
  }
  const { duid } = parseExternalId(vacuumExternalId);
  logger.info(`onWidgetGet(map) <- ${duid}`);
  const { map, base64, imageKey } = await renderMapForDuid(duid);
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
  rememberStatus(duid, status);
  await publishTransport(duid, vacuumExternalId);
  return buildMapWidgetContent(map, {
    imageKey,
    vacuumExternalId,
    status,
    consumables,
    settings,
    language,
  });
});

// The suction buttons of the widget: a suction change only, whatever the robot
// (the clean-mode feature would switch a mop-capable robot between Vacuum,
// Vac & Mop and Mop instead). The robot the widget shows comes from its settings.
gladys.onWidgetAction(MAP_WIDGET_KEY, async (actionKey, params, { settings }) => {
  if (actionKey !== FAN_POWER_WIDGET_ACTION) {
    throw new Error(`Unknown widget action: ${actionKey}`);
  }
  const vacuumExternalId = settings && settings.vacuum;
  if (!vacuumExternalId) {
    throw new Error('No vacuum selected for the map widget');
  }
  const { duid } = parseExternalId(vacuumExternalId);
  const level = String(params && params.level);
  const cleanMode = FAN_POWER_MODES[level];
  if (cleanMode === undefined) {
    throw new Error(`Unknown suction level: "${level}"`);
  }
  logger.info(`onWidgetAction(map) <- ${duid} suction ${level}`);
  const command = buildSetCommand(FEATURE_CODES.CLEAN_MODE, cleanMode);
  await roborock.sendCommand(duid, command.method, command.params);
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
    if (err.linked) {
      // The session is valid: keep it, so the next start (or the hourly retry)
      // loads the robots without burning another single-use code.
      await persistSession();
    }
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
  roborock = newRoborockClient({});
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
  // The transport preference applies to the next RPC: no reconnection needed.
  preferLocal = readPreferLocal(newConfig);
  roborock.setPreferLocal(preferLocal);
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
    preferLocal = readPreferLocal(rawConfig);
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
// Log an uncaught exception, then let the process exit so Gladys restarts the
// container in a clean state rather than leaving it running undefined. Unhandled
// rejections are deliberately NOT swallowed: the known source (the 301 waiter)
// is handled at its await site, and masking the rest would hide real bugs while
// the integration silently stops publishing.
process.on('uncaughtException', (err) => {
  logger.error(`Uncaught exception, exiting: ${err && err.message ? err.message : err}`);
  process.exit(1);
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the Roborock integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
