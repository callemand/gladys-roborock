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

import { createHash } from 'node:crypto';

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';

import { FEATURE_CODES, VACUUM_CLEANER_MODE } from '../constants.js';

export const MAP_WIDGET_KEY = 'map';

// Bumped whenever the renderer OUTPUT changes, so the core (which caches a widget
// image one hour per key) serves the new render. The widget CONTENT is re-pulled
// on its own ttl.
export const MAP_RENDER_VERSION = 8;

// The core caps an image key at 64 characters (`^[a-z0-9][a-z0-9-]{0,63}$`). The
// hex form `map-<hex(duid)>-<sig>-r<ver>` is reversible and survives a restart,
// but hex doubles the duid length, so for a long duid the key would overflow. In
// that case we fall back to a short hash and keep the duid in this registry for
// the reverse lookup (onWidgetGetImage), with the hex decode as the primary path.
const duidByHashedKey = new Map();
const MAX_HASHED_KEYS = 64;

function rememberHashedKey(key, duid) {
  duidByHashedKey.set(key, duid);
  // The signature changes on every visual change, so cap the registry (the live
  // map can produce many keys per cleaning) and evict the oldest entries.
  while (duidByHashedKey.size > MAX_HASHED_KEYS) {
    duidByHashedKey.delete(duidByHashedKey.keys().next().value);
  }
}

/**
 * Build the per-map image key, matching the core grammar `^[a-z0-9][a-z0-9-]{0,63}$`.
 * The signature is a marker of the rendered image: pass a hash of the PNG bytes so
 * the key — and therefore the core's cached image — changes only when the picture
 * actually changes (no needless `<img>` swap / flash when nothing moved).
 * @param {string} duid the Roborock device id
 * @param {string|number} signature a change marker of the rendered image
 * @returns {string} the image key
 */
export function mapImageKey(duid, signature) {
  const sig = String(signature);
  const hexKey = `map-${Buffer.from(String(duid)).toString('hex')}-${sig}-r${MAP_RENDER_VERSION}`;
  if (hexKey.length <= 64) {
    return hexKey;
  }
  const short = createHash('sha1').update(String(duid)).digest('hex').slice(0, 16);
  const hashedKey = `maph-${short}-${sig}-r${MAP_RENDER_VERSION}`;
  rememberHashedKey(hashedKey, String(duid));
  return hashedKey;
}

/**
 * Recover the duid from an image key built by {@link mapImageKey}.
 * @param {string} key the image key
 * @returns {string|null} the duid, or null when the key is not ours
 */
export function duidFromImageKey(key) {
  const match = /^map-([0-9a-f]+)-[a-z0-9]+(?:-r\d+)?$/.exec(String(key || ''));
  if (match) {
    try {
      return Buffer.from(match[1], 'hex').toString('utf8');
    } catch {
      return null;
    }
  }
  return duidByHashedKey.get(String(key || '')) || null;
}

// The widget action (onWidgetAction) behind the suction buttons: `params.level`
// is a FAN_POWER_MODES key (quiet / balanced / turbo / max).
export const FAN_POWER_WIDGET_ACTION = 'fan_power';

// Catalogue of the actions the user can bind to the two configurable buttons.
// Each maps either to a device feature + value (relayed to onSetValue) or to a
// widget action (relayed to onWidgetAction). Keys are the stable values of the
// manifest `action1` / `action2` selects.
export const WIDGET_ACTIONS = {
  start: {
    label: { en: 'Start', fr: 'Démarrer', de: 'Start', es: 'Iniciar' },
    icon: 'play',
    feature: FEATURE_CODES.RUN_MODE,
    value: VACUUM_CLEANER_MODE.CLEANING,
  },
  stop: {
    // RUN_MODE + IDLE maps to app_stop (not app_pause): this ends the cycle, it
    // does not pause it, so the button is labelled accordingly. A true pause is
    // available as the `pause_cleaning` scene action.
    label: { en: 'Stop', fr: 'Arrêter', de: 'Stopp', es: 'Detener' },
    icon: 'square',
    feature: FEATURE_CODES.RUN_MODE,
    value: VACUUM_CLEANER_MODE.IDLE,
  },
  dock: {
    label: { en: 'Dock', fr: 'Retour base', de: 'Zur Station', es: 'A la base' },
    icon: 'home',
    feature: FEATURE_CODES.DOCK,
    value: 1,
  },
  // The four suction levels: a suction change only, whatever the robot. They
  // go through a widget action, NOT the clean-mode feature: on a mop-capable
  // robot that feature is the Vacuum / Vac & Mop / Mop choice (issue #13), and
  // "Max" would otherwise switch the robot to Vacuum only.
  quiet: {
    label: { en: 'Quiet', fr: 'Silencieux', de: 'Leise', es: 'Silencioso' },
    icon: 'moon',
    action: FAN_POWER_WIDGET_ACTION,
    level: 'quiet',
  },
  balanced: {
    label: { en: 'Balanced', fr: 'Équilibré', de: 'Standard', es: 'Equilibrado' },
    icon: 'wind',
    action: FAN_POWER_WIDGET_ACTION,
    level: 'balanced',
  },
  turbo: {
    label: { en: 'Turbo', fr: 'Turbo', de: 'Turbo', es: 'Turbo' },
    icon: 'zap',
    action: FAN_POWER_WIDGET_ACTION,
    level: 'turbo',
  },
  max: {
    label: { en: 'Max', fr: 'Max', de: 'Max', es: 'Máx' },
    icon: 'zap',
    action: FAN_POWER_WIDGET_ACTION,
    level: 'max',
  },
};

// The languages Gladys speaks. Every widget text exists in all four: the core
// falls back to English for a missing language, which left a German dashboard
// with a mix of English labels and French values (issue #13).
export const WIDGET_LANGUAGES = ['en', 'fr', 'de', 'es'];
const DEFAULT_LANGUAGE = 'en';

/**
 * Pick the text of a multi-language object in the given language (English,
 * then the first available text, when it is missing).
 * @param {object} texts the texts by language
 * @param {string} [language] the Gladys user language
 * @returns {string} the text
 */
function localized(texts, language) {
  return texts[language] || texts[DEFAULT_LANGUAGE] || Object.values(texts).find(Boolean) || '';
}

// Roborock raw state code -> short label for the status block.
const STATE_LABELS = {
  docked: { en: 'Docked', fr: 'À la base', de: 'An der Station', es: 'En la base' },
  idle: { en: 'Idle', fr: 'Au repos', de: 'Bereit', es: 'En reposo' },
  cleaning: { en: 'Cleaning', fr: 'Nettoyage', de: 'Reinigung', es: 'Limpiando' },
  returning: { en: 'Returning to dock', fr: 'Retour à la base', de: 'Rückkehr', es: 'Volviendo' },
  paused: { en: 'Paused', fr: 'En pause', de: 'Pausiert', es: 'En pausa' },
  error: { en: 'Error', fr: 'Erreur', de: 'Fehler', es: 'Error' },
  moving: { en: 'Moving', fr: 'Déplacement', de: 'Unterwegs', es: 'En movimiento' },
  zone: { en: 'Zone cleaning', fr: 'Nettoyage zone', de: 'Zonenreinigung', es: 'Limpieza de zona' },
  room: { en: 'Room cleaning', fr: 'Nettoyage pièce', de: 'Raumreinigung', es: 'Limpieza de sala' },
  emptying: { en: 'Emptying the bin', fr: 'Vidage du bac', de: 'Entleerung', es: 'Vaciando' },
  washing: {
    en: 'Washing the mop',
    fr: 'Lavage serpillière',
    de: 'Mopp waschen',
    es: 'Lavando mopa',
  },
  toWash: { en: 'Going to wash', fr: 'Retour au lavage', de: 'Zum Waschen', es: 'Yendo a lavar' },
  mapping: { en: 'Mapping', fr: 'Cartographie', de: 'Kartierung', es: 'Mapeando' },
  unknown: { en: 'Unknown', fr: 'Inconnu', de: 'Unbekannt', es: 'Desconocido' },
};
const STATE_KEYS = {
  2: 'docked',
  3: 'idle',
  5: 'cleaning',
  6: 'returning',
  8: 'docked',
  10: 'paused',
  11: 'cleaning',
  12: 'error',
  15: 'returning',
  16: 'moving',
  17: 'zone',
  18: 'room',
  22: 'emptying',
  23: 'washing',
  25: 'washing',
  26: 'toWash',
  29: 'mapping',
  100: 'docked',
};

/**
 * Short label for a Roborock state code, in the given language.
 * @param {number} state the raw Roborock state
 * @param {string} [language] the Gladys user language (defaults to English)
 * @returns {string} the label
 */
export function roborockStateLabel(state, language = DEFAULT_LANGUAGE) {
  return localized(STATE_LABELS[STATE_KEYS[Number(state)] || 'unknown'], language);
}

const DAY_WORDS = {
  today: { en: 'Today', fr: "Aujourd'hui", de: 'Heute', es: 'Hoy' },
  yesterday: { en: 'Yesterday', fr: 'Hier', de: 'Gestern', es: 'Ayer' },
};

/**
 * Format a cleaning timestamp as "Today, HH:MM" / "Yesterday, HH:MM" /
 * "DD/MM, HH:MM" in the given language. Uses the process local time zone.
 * @param {number} tsSeconds unix timestamp in seconds
 * @param {number} [now] current time in ms (for testing)
 * @param {string} [language] the Gladys user language (defaults to English)
 * @returns {string} the label
 */
export function formatCleanTimestamp(tsSeconds, now = Date.now(), language = DEFAULT_LANGUAGE) {
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
    return `${localized(DAY_WORDS.today, language)}, ${hhmm}`;
  }
  if (sameDay(d, yesterday)) {
    return `${localized(DAY_WORDS.yesterday, language)}, ${hhmm}`;
  }
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  // German dates read day.month; the others day/month
  return language === 'de' ? `${dd}.${mm}., ${hhmm}` : `${dd}/${mm}, ${hhmm}`;
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
  const button = { type: 'button', label: a.label, style, icon: a.icon };
  if (a.action) {
    return { ...button, action: { key: a.action, params: { level: a.level } } };
  }
  return { ...button, device_feature: `${vacuumExternalId}:${a.feature}`, value: a.value };
}

/**
 * Build the full vacuum widget content (tiles + map + status + buttons).
 * @param {object|null} map a parsed map (from client.getMap, room names attached),
 *   or null when neither the map nor the surface tile is shown
 * @param {object} params parameters
 * @param {string} [params.imageKey] the image key declared in the content (none
 *   without a map)
 * @param {string} params.vacuumExternalId the vacuum device external_id
 * @param {object} [params.status] the get_status result
 * @param {object} [params.consumables] remaining life % { mainBrush, sideBrush, filter, sensor }
 * @param {object} [params.settings] the widget instance settings (action1, action2)
 * @param {string} [params.language] the Gladys user language, for the values the
 *   integration renders itself (state, dates); labels carry every language
 * @param {number} [params.now] current time in ms (for testing)
 * @returns {object} a WidgetContent
 */
export function buildMapWidgetContent(
  map,
  {
    imageKey,
    vacuumExternalId,
    status = {},
    consumables = {},
    settings = {},
    language = DEFAULT_LANGUAGE,
    now = Date.now(),
  },
) {
  const surfaceM2 = Math.round((Number(status.clean_area) || 0) / 1e6);
  const maxArea = Math.max(map ? homeAreaM2(map) : 0, surfaceM2, 1);
  const durationMin = Math.round((Number(status.clean_time) || 0) / 60);
  const v = vacuumExternalId;
  // The battery tile, the surface tile and the map are each optional (widget
  // settings, on by default): two robot widgets of different brands can then
  // be aligned side by side. The tiles row is a flex row: a lone tile takes the
  // whole width by itself.
  const show = (key) => settings[key] !== false;

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
    show('show_battery') && {
      type: 'value',
      label: { en: 'Battery', fr: 'Batterie', de: 'Akku', es: 'Batería' },
      device_feature: `${v}:${FEATURE_CODES.BATTERY}`,
      icon: 'battery',
    },
    show('show_surface') && {
      type: 'gauge',
      label: { en: 'Surface', fr: 'Surface', de: 'Fläche', es: 'Superficie' },
      value: Math.min(surfaceM2, maxArea),
      min: 0,
      max: maxArea,
      unit: 'm²',
      color: WIDGET_COLORS.PRIMARY,
    },
    show('show_map') &&
      imageKey && {
        type: 'image',
        key: imageKey,
        alt: {
          en: 'Robot cleaning map',
          fr: 'Carte de nettoyage du robot',
          de: 'Reinigungskarte des Roboters',
          es: 'Mapa de limpieza del robot',
        },
        fit: 'contain',
      },
    {
      type: 'status',
      items: [
        {
          label: { en: 'State', fr: 'État', de: 'Status', es: 'Estado' },
          value: roborockStateLabel(status.state, language),
          color: WIDGET_COLORS.INFO,
        },
        {
          // status.last_clean_t is the END of the last cleaning; the dedicated
          // "last-clean-start" device feature exposes the START. Label the end
          // explicitly so the two are not read as the same instant.
          label: {
            en: 'Last cleaning (end)',
            fr: 'Fin du dernier nettoyage',
            de: 'Letzte Reinigung (Ende)',
            es: 'Última limpieza (fin)',
          },
          value: formatCleanTimestamp(Number(status.last_clean_t), now, language),
          color: WIDGET_COLORS.NEUTRAL,
        },
        {
          label: { en: 'Duration', fr: 'Durée', de: 'Dauer', es: 'Duración' },
          value: `${durationMin} min`,
          color: WIDGET_COLORS.NEUTRAL,
        },
        percentRow({ en: 'Filter', fr: 'Filtre', de: 'Filter', es: 'Filtro' }, consumables.filter),
        percentRow(
          { en: 'Main brush', fr: 'Brosse principale', de: 'Hauptbürste', es: 'Cepillo principal' },
          consumables.mainBrush,
        ),
        percentRow(
          { en: 'Side brush', fr: 'Brosse latérale', de: 'Seitenbürste', es: 'Cepillo lateral' },
          consumables.sideBrush,
        ),
        percentRow(
          { en: 'Sensors', fr: 'Capteurs', de: 'Sensoren', es: 'Sensores' },
          consumables.sensor,
        ),
      ],
    },
    ...buttons.filter(Boolean),
  ];

  return { ttl_seconds: 120, components: components.filter(Boolean) };
}
