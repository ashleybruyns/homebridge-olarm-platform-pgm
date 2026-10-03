/**
 * Platform and plugin identifiers
 */
export const PLATFORM_NAME = 'Olarm';
export const PLUGIN_NAME = 'homebridge-olarm-platform-pgm';

/**
 * Olarm public API (https://user.olarm.com/#/api/documentation)
 */
export const API_BASE_URL = 'https://api.olarm.com/api/v4';

/**
 * Olarm public MQTT feed, as used by Olarm's official client
 * (https://github.com/olarmtech/olarmflowclient-python).
 * Authenticates with the API key; the client id is `<userId>-<suffix>`.
 */
export const MQTT_URL = 'wss://mqtt-pubapi.olarm.com:443/mqtt';
export const MQTT_USERNAME = 'public-api-user-v1';

/**
 * Default client id suffix. Each connection for a user needs a unique suffix,
 * otherwise the broker disconnects the older client when a new one connects.
 * Olarm's own clients use small numbers (the Home Assistant integration counts
 * up from 1, the client examples use 4), so a higher number avoids clashes.
 */
export const DEFAULT_MQTT_CLIENT_ID_SUFFIX = '8';
