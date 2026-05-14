// Optional MQTT publisher for Home Assistant integration. Publish-only:
// after each successful poll we emit per-sensor state JSON; we also publish
// Home Assistant MQTT discovery configs so each sensor shows up grouped as
// one device with five entities (temperature, humidity, dewpoint, vpd,
// battery voltage). No subscriber, no queue — a dropped publish is fine,
// the authoritative copy lives in SQLite.
//
// Activation is purely env-driven: when MQTT_URL is unset, `connect()` is a
// no-op and the publish functions return silently. That keeps the dependency
// optional for LAN deploys that have no broker.
//
// MQTT_URL              — e.g. mqtt://broker.local:1883 (omit → publisher off)
// MQTT_USERNAME         — optional broker auth
// MQTT_PASSWORD         — optional broker auth
// MQTT_TOPIC_PREFIX     — state topic prefix (default: sensorpush/)
// MQTT_DISCOVERY_PREFIX — HA discovery prefix (default: homeassistant/)
//
// Resolution: connect(config) reads explicit args first, then env vars, then
// defaults. The explicit-args path exists for tests and future programmatic
// callers; production wires it via env in docker-compose.yml.

import mqtt from 'mqtt';

let _client    = null;
let _connected = false;
let _settings  = null;

// Five HA discovery entities per sensor. value_key defaults to key when the
// metric name in the state JSON matches the HA discovery entity slug.
const METRICS = [
  { key: 'temperature', name: 'Temperature', device_class: 'temperature', unit: '°F' },
  { key: 'humidity',    name: 'Humidity',    device_class: 'humidity',    unit: '%'  },
  { key: 'dewpoint',    name: 'Dewpoint',    device_class: 'temperature', unit: '°F' },
  { key: 'vpd',         name: 'VPD',         device_class: null,          unit: 'kPa' },
  { key: 'battery',     name: 'Battery',     device_class: 'voltage',     unit: 'V', value_key: 'battery_voltage' },
];

/**
 * Connect to the configured broker. Returns the underlying mqtt client when
 * the publisher activates, or null when MQTT_URL is unset (no-op mode).
 * Safe to call once at startup; subsequent calls without disconnect() return
 * the existing client.
 */
export function connect(config = {}) {
  if (_client) return _client;

  const url = (config.url ?? process.env.MQTT_URL ?? '').trim();
  if (!url) return null;

  _settings = {
    url,
    username:        config.username        ?? process.env.MQTT_USERNAME     ?? undefined,
    password:        config.password        ?? process.env.MQTT_PASSWORD     ?? undefined,
    topicPrefix:     config.topicPrefix     ?? process.env.MQTT_TOPIC_PREFIX ?? 'sensorpush/',
    discoveryPrefix: config.discoveryPrefix ?? process.env.MQTT_DISCOVERY_PREFIX ?? 'homeassistant/',
  };

  const opts = {};
  if (_settings.username) opts.username = _settings.username;
  if (_settings.password) opts.password = _settings.password;

  _client = mqtt.connect(url, opts);
  _client.on('connect', () => {
    _connected = true;
    console.log(`[mqtt] connected to ${url}`);
  });
  _client.on('close', () => {
    _connected = false;
  });
  _client.on('error', err => {
    console.error('[mqtt] error:', err?.message || err);
  });
  _client.on('reconnect', () => {
    console.log('[mqtt] reconnecting');
  });
  return _client;
}

/**
 * Publish one sensor's latest reading as JSON to <prefix><sensor_id>/state.
 * Retained so HA picks up the last value on restart. No-op when the
 * publisher isn't connected (broker unreachable or MQTT_URL unset).
 */
export function publishReading(sensor, reading) {
  if (!_client || !_connected || !sensor?.id) return;
  const topic   = `${_settings.topicPrefix}${sensor.id}/state`;
  const payload = JSON.stringify({
    temperature:     reading?.temperature     ?? null,
    humidity:        reading?.humidity        ?? null,
    dewpoint:        reading?.dewpoint        ?? null,
    vpd:             reading?.vpd             ?? null,
    battery_voltage: reading?.battery_voltage ?? sensor.batteryVoltage ?? null,
    rssi:            sensor.rssi              ?? null,
    last_seen:       reading?.ts              ?? null,
  });
  _client.publish(topic, payload, { qos: 0, retain: true });
}

/**
 * Publish HA discovery configs for every (sensor × metric) pair. Retained so
 * HA reads them once on broker reconnect even when the recorder is down.
 * Re-publishing is idempotent — HA dedupes by unique_id.
 */
export function publishDiscovery(sensors) {
  if (!_client || !_connected || !Array.isArray(sensors)) return;
  for (const sensor of sensors) {
    if (!sensor?.id) continue;
    for (const m of METRICS) {
      const topic    = `${_settings.discoveryPrefix}sensor/${sensor.id}_${m.key}/config`;
      const valueKey = m.value_key || m.key;
      const cfg      = {
        name:                m.name,
        unique_id:           `sensorpush_${sensor.id}_${m.key}`,
        state_topic:         `${_settings.topicPrefix}${sensor.id}/state`,
        value_template:      `{{ value_json.${valueKey} }}`,
        unit_of_measurement: m.unit,
        state_class:         'measurement',
        device: {
          identifiers:  [`sensorpush_${sensor.id}`],
          name:         sensor.name || sensor.id,
          manufacturer: 'SensorPush',
          model:        sensor.type ?? undefined,
          via_device:   'sensorpush-recorder',
        },
      };
      if (m.device_class) cfg.device_class = m.device_class;
      _client.publish(topic, JSON.stringify(cfg), { qos: 0, retain: true });
    }
  }
}

/**
 * Tear down the MQTT client. Safe to call when not connected.
 */
export function disconnect() {
  if (!_client) return;
  try { _client.end(true); } catch (_) {}
  _client    = null;
  _connected = false;
  _settings  = null;
}

export function isConnected() {
  return _connected;
}

// Test hook — clears module-level state without touching a live client.
export function _resetMqttState() {
  _client    = null;
  _connected = false;
  _settings  = null;
}
