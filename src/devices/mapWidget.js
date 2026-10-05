// -----------------------------------------------------------------------------
// Roborock vacuum dashboard widget (SDK >= 0.14 "dashboard widgets").
//
// A single rich widget, like the Roborock app card: battery / cleaned-surface /
// duration tiles, the map image, a status block (state, last cleaning, consumable
// wear) and the control buttons. Two of the buttons are user-configurable from a
// fixed catalogue of vacuum commands (widget settings action1/action2).
//
// onWidgetGet resolves the content, onWidgetGetImage resolves the raw PNG bytes.
// The image key embeds the robot duid (hex) and the map sequence, so it changes
// whenever the map changes (the core caches an image one hour per key) and the
// duid can be recovered when the core asks for an image after a restart.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';

import { FEATURE_CODES, VACUUM_CLEANER_CLEAN_MODE, VACUUM_CLEANER_MODE } from '../constants.js';

export const MAP_WIDGET_KEY = 'map';

// Bumped whenever the renderer OUTPUT changes, so the core (which caches a widget
// image one hour per key) serves the new render even when the robot's map
// sequence has not changed. The widget CONTENT is re-pulled on its own ttl.
export const MAP_RENDER_VERSION = 7;

/**
 * Build the per-map image key (`map-<hex(duid)>-<sequence>-r<render version>`),
 * matching the core key grammar `^[a-z0-9][a-z0-9-]{0,63}$`.
 * @param {string} duid the Roborock device id
 * @param {number} sequence the RRMap map sequence (change marker)
 * @returns {string} the image key
 */
export function mapImageKey(duid, sequence) {
  const hex = Buffer.from(String(duid)).toString('hex');
  return `map-${hex}-${Number(sequence) || 0}-r${MAP_RENDER_VERSION}`;
}

/**
 * Recover the duid from an image key built by {@link mapImageKey}.
 * @param {string} key the image key
 * @returns {string|null} the duid, or null when the key is not ours
 */
export function duidFromImageKey(key) {
  const match = /^map-([0-9a-f]+)-\d+(?:-r\d+)?$/.exec(String(key || ''));
  if (!match) {
    return null;
  }
  try {
    return Buffer.from(match[1], 'hex').toString('utf8');
  } catch {
    return null;
  }
}

// Catalogue of the actions the user can bind to the two configurable buttons.
// Each maps to a device feature + value (relayed to onSetValue). Keys are the
// stable values of the manifest `action1` / `action2` selects.
export const WIDGET_ACTIONS = {
  start: {
    label: { en: 'Start', fr: 'Démarrer' },
    icon: 'play',
    feature: FEATURE_CODES.RUN_MODE,
    value: VACUUM_CLEANER_MODE.CLEANING,
  },
  pause: {
    label: { en: 'Pause', fr: 'Pause' },
    icon: 'pause',
    feature: FEATURE_CODES.RUN_MODE,
    value: VACUUM_CLEANER_MODE.IDLE,
  },
  dock: {
    label: { en: 'Dock', fr: 'Retour base' },
    icon: 'home',
    feature: FEATURE_CODES.DOCK,
    value: 1,
  },
  quiet: {
    label: { en: 'Quiet', fr: 'Silencieux' },
    icon: 'moon',
    feature: FEATURE_CODES.CLEAN_MODE,
    value: VACUUM_CLEANER_CLEAN_MODE.QUIET,
  },
  balanced: {
    label: { en: 'Balanced', fr: 'Équilibré' },
    icon: 'wind',
    feature: FEATURE_CODES.CLEAN_MODE,
    value: VACUUM_CLEANER_CLEAN_MODE.AUTO,
  },
  turbo: {
    label: { en: 'Turbo', fr: 'Turbo' },
    icon: 'zap',
    feature: FEATURE_CODES.CLEAN_MODE,
    value: VACUUM_CLEANER_CLEAN_MODE.DEEP_CLEAN,
  },
  max: {
    label: { en: 'Max', fr: 'Max' },
    icon: 'zap',
    feature: FEATURE_CODES.CLEAN_MODE,
    value: VACUUM_CLEANER_CLEAN_MODE.VACUUM,
  },
};

// Roborock raw state code -> short French label for the status block.
const STATE_LABELS = {
  2: 'À la base',
  3: 'Au repos',
  5: 'Nettoyage',
  6: 'Retour à la base',
  8: 'À la base',
  10: 'En pause',
  11: 'Nettoyage',
  12: 'Erreur',
  15: 'Retour à la base',
  16: 'Déplacement',
  17: 'Nettoyage zone',
  18: 'Nettoyage pièce',
  22: 'Vidage du bac',
  23: 'Lavage serpillière',
  25: 'Lavage serpillière',
  26: 'Retour au lavage',
  29: 'Cartographie',
  100: 'À la base',
};

/**
 * Short French label for a Roborock state code.
 * @param {number} state the raw Roborock state
 * @returns {string} the label
 */
export function roborockStateLabel(state) {
  return STATE_LABELS[Number(state)] || 'Inconnu';
}

/**
 * Format a cleaning timestamp as "Aujourd'hui, HH:MM" / "Hier, HH:MM" / "JJ/MM, HH:MM".
 * Uses the process local time zone.
 * @param {number} tsSeconds unix timestamp in seconds
 * @param {number} [now] current time in ms (for testing)
 * @returns {string} the label
 */
export function formatCleanTimestamp(tsSeconds, now = Date.now()) {
  if (!tsSeconds) {
    return '—';
  }
  const d = new Date(tsSeconds * 1000);
  const ref = new Date(now);
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const sameDay = (a, b) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  const yesterday = new Date(ref);
  yesterday.setDate(ref.getDate() - 1);
  if (sameDay(d, ref)) {
    return `Aujourd'hui, ${hhmm}`;
  }
  if (sameDay(d, yesterday)) {
    return `Hier, ${hhmm}`;
  }
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}, ${hhmm}`;
}

/**
 * Total mapped surface of the named rooms, in m² (each map cell is
 * pixelSizeMm × pixelSizeMm).
 * @param {object} map a parsed map
 * @returns {number} the area in m², rounded
 */
export function homeAreaM2(map) {
  const cellM2 = (map.pixelSizeMm / 1000) ** 2;
  const px = map.segments.filter((s) => s.named).reduce((sum, s) => sum + (s.pixelCount || 0), 0);
  return Math.round(px * cellM2);
}

// Colour of a consumable / percentage row by how much life is left.
function wearColor(percent) {
  if (percent === null || percent === undefined) return WIDGET_COLORS.NEUTRAL;
  if (percent < 10) return WIDGET_COLORS.DANGER;
  if (percent < 25) return WIDGET_COLORS.WARNING;
  return WIDGET_COLORS.SUCCESS;
}

function percentRow(label, percent) {
  return {
    label,
    value: percent === null || percent === undefined ? '—' : `${Math.round(percent)} %`,
    color: wearColor(percent),
  };
}

function actionButton(key, vacuumExternalId, style) {
  const a = WIDGET_ACTIONS[key];
  if (!a) return null;
  return {
    type: 'button',
    label: a.label,
    style,
    icon: a.icon,
    device_feature: `${vacuumExternalId}:${a.feature}`,
    value: a.value,
  };
}

/**
 * Build the full vacuum widget content (tiles + map + status + buttons).
 * @param {object} map a parsed map (from client.getMap, room names attached)
 * @param {object} params parameters
 * @param {string} params.imageKey the image key declared in the content
 * @param {string} params.vacuumExternalId the vacuum device external_id
 * @param {object} [params.status] the get_status result
 * @param {object} [params.consumables] remaining life % { mainBrush, sideBrush, filter, sensor }
 * @param {object} [params.settings] the widget instance settings (action1, action2)
 * @param {number} [params.now] current time in ms (for testing)
 * @returns {object} a WidgetContent
 */
export function buildMapWidgetContent(
  map,
  { imageKey, vacuumExternalId, status = {}, consumables = {}, settings = {}, now = Date.now() },
) {
  const surfaceM2 = Math.round((Number(status.clean_area) || 0) / 1e6);
  const maxArea = Math.max(homeAreaM2(map), surfaceM2, 1);
  const durationMin = Math.round((Number(status.clean_time) || 0) / 60);
  const v = vacuumExternalId;

  // Start + Dock are fixed; the other two buttons are user-configured. Kept to
  // 4 buttons (the SDK cap) so the whole card stays within the 8-component
  // budget — hence the duration lives in the status block, not as its own tile.
  const buttons = [actionButton('start', v, 'primary'), actionButton('dock', v, 'secondary')];
  for (const key of [settings.action1, settings.action2]) {
    if (key && key !== 'none' && WIDGET_ACTIONS[key]) {
      buttons.push(actionButton(key, v, 'secondary'));
    }
  }

  const components = [
    {
      type: 'value',
      label: { en: 'Battery', fr: 'Batterie' },
      device_feature: `${v}:${FEATURE_CODES.BATTERY}`,
      icon: 'battery',
    },
    {
      type: 'gauge',
      label: { en: 'Surface', fr: 'Surface' },
      value: Math.min(surfaceM2, maxArea),
      min: 0,
      max: maxArea,
      unit: 'm²',
      color: WIDGET_COLORS.PRIMARY,
    },
    {
      type: 'image',
      key: imageKey,
      alt: { en: 'Robot cleaning map', fr: 'Carte de nettoyage du robot' },
      fit: 'contain',
    },
    {
      type: 'status',
      items: [
        {
          label: { en: 'State', fr: 'État' },
          value: roborockStateLabel(status.state),
          color: WIDGET_COLORS.INFO,
        },
        {
          label: { en: 'Last cleaning', fr: 'Dernier nettoyage' },
          value: formatCleanTimestamp(Number(status.last_clean_t), now),
          color: WIDGET_COLORS.NEUTRAL,
        },
        {
          label: { en: 'Duration', fr: 'Durée' },
          value: `${durationMin} min`,
          color: WIDGET_COLORS.NEUTRAL,
        },
        percentRow({ en: 'Filter', fr: 'Filtre' }, consumables.filter),
        percentRow({ en: 'Main brush', fr: 'Brosse principale' }, consumables.mainBrush),
        percentRow({ en: 'Side brush', fr: 'Brosse latérale' }, consumables.sideBrush),
        percentRow({ en: 'Sensors', fr: 'Capteurs' }, consumables.sensor),
      ],
    },
    ...buttons.filter(Boolean),
  ];

  return { ttl_seconds: 120, components };
}
