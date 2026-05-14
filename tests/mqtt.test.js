import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Capture the registered event handlers and the most-recently-constructed
// fake client so each test can simulate 'connect' / 'close' / 'error' and
// inspect publish calls. mqtt.connect() returns a singleton-ish client per
// connect() call; tests reset by calling _resetMqttState() between cases.
let mockClient;
const handlers = {};

vi.mock('mqtt', () => ({
  default: {
    connect: vi.fn(() => {
      mockClient = {
        on: vi.fn((evt, cb) => { handlers[evt] = cb; }),
        publish: vi.fn(),
        end: vi.fn(),
      };
      return mockClient;
    }),
  },
}));

import mqtt from 'mqtt';
import { connect, publishReading, publishDiscovery, disconnect, isConnected, _resetMqttState } from '../mqtt.js';

const SENSOR = {
  id:             'abc.123',
  name:           'Crawlspace',
  type:           'HT1',
  rssi:           -67,
  batteryVoltage: 2.91,
};

const READING = {
  ts:              1_700_000_000,
  temperature:     71.2,
  humidity:        48.5,
  dewpoint:        50.1,
  vpd:             1.05,
  battery_voltage: 2.9,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockClient = undefined;
  for (const k of Object.keys(handlers)) delete handlers[k];
  _resetMqttState();
  // Strip env so tests start from a clean slate; restore in afterEach.
  delete process.env.MQTT_URL;
  delete process.env.MQTT_USERNAME;
  delete process.env.MQTT_PASSWORD;
  delete process.env.MQTT_TOPIC_PREFIX;
  delete process.env.MQTT_DISCOVERY_PREFIX;
});

afterEach(() => {
  _resetMqttState();
});

describe('connect — no-op when MQTT_URL is unset', () => {
  it('returns null and never constructs a client', () => {
    expect(connect()).toBeNull();
    expect(mqtt.connect).not.toHaveBeenCalled();
    expect(mockClient).toBeUndefined();
  });

  it('publishReading is a no-op with no client', () => {
    connect();
    publishReading(SENSOR, READING);
    expect(mockClient).toBeUndefined();
  });

  it('publishDiscovery is a no-op with no client', () => {
    connect();
    publishDiscovery([SENSOR]);
    expect(mockClient).toBeUndefined();
  });

  it('isConnected stays false', () => {
    connect();
    expect(isConnected()).toBe(false);
  });
});

describe('connect — activated by MQTT_URL', () => {
  it('reads url + auth from env when args omitted', () => {
    process.env.MQTT_URL      = 'mqtt://broker.lan:1883';
    process.env.MQTT_USERNAME = 'u';
    process.env.MQTT_PASSWORD = 'p';
    const c = connect();
    expect(c).toBe(mockClient);
    expect(mqtt.connect).toHaveBeenCalledWith('mqtt://broker.lan:1883', { username: 'u', password: 'p' });
  });

  it('explicit config args win over env', () => {
    process.env.MQTT_URL = 'mqtt://env.lan:1883';
    connect({ url: 'mqtt://arg.lan:1883', username: 'au', password: 'ap' });
    expect(mqtt.connect).toHaveBeenCalledWith('mqtt://arg.lan:1883', { username: 'au', password: 'ap' });
  });

  it('omits username/password options when neither is provided', () => {
    connect({ url: 'mqtt://anon.lan' });
    expect(mqtt.connect).toHaveBeenCalledWith('mqtt://anon.lan', {});
  });

  it('returns the same client on second connect (idempotent)', () => {
    connect({ url: 'mqtt://broker.lan' });
    const c2 = connect({ url: 'mqtt://broker.lan' });
    expect(c2).toBe(mockClient);
    expect(mqtt.connect).toHaveBeenCalledTimes(1);
  });

  it('isConnected reflects connect/close events', () => {
    connect({ url: 'mqtt://broker.lan' });
    expect(isConnected()).toBe(false);
    handlers.connect();
    expect(isConnected()).toBe(true);
    handlers.close();
    expect(isConnected()).toBe(false);
  });

  it('error handler does not throw', () => {
    connect({ url: 'mqtt://broker.lan' });
    expect(() => handlers.error(new Error('boom'))).not.toThrow();
  });
});

describe('publishReading — state topic and payload', () => {
  beforeEach(() => {
    connect({ url: 'mqtt://broker.lan' });
    handlers.connect();
  });

  it('publishes nothing until the connect event fires', () => {
    _resetMqttState();
    connect({ url: 'mqtt://broker.lan' });
    publishReading(SENSOR, READING);
    expect(mockClient.publish).not.toHaveBeenCalled();
  });

  it('publishes to <prefix><sensor_id>/state with retained QoS 0', () => {
    publishReading(SENSOR, READING);
    expect(mockClient.publish).toHaveBeenCalledTimes(1);
    const [topic, body, opts] = mockClient.publish.mock.calls[0];
    expect(topic).toBe('sensorpush/abc.123/state');
    expect(opts).toEqual({ qos: 0, retain: true });
    expect(JSON.parse(body)).toEqual({
      temperature:     71.2,
      humidity:        48.5,
      dewpoint:        50.1,
      vpd:             1.05,
      battery_voltage: 2.9,
      rssi:            -67,
      last_seen:       1_700_000_000,
    });
  });

  it('honors a custom MQTT_TOPIC_PREFIX from env', () => {
    _resetMqttState();
    process.env.MQTT_URL          = 'mqtt://broker.lan';
    process.env.MQTT_TOPIC_PREFIX = 'house/sensors/';
    connect();
    handlers.connect();
    publishReading(SENSOR, READING);
    expect(mockClient.publish.mock.calls[0][0]).toBe('house/sensors/abc.123/state');
  });

  it('falls back to sensor.batteryVoltage when reading.battery_voltage is null', () => {
    publishReading(SENSOR, { ...READING, battery_voltage: null });
    const body = JSON.parse(mockClient.publish.mock.calls[0][1]);
    expect(body.battery_voltage).toBe(2.91);
  });

  it('emits nulls (not undefined) for missing metric fields', () => {
    publishReading({ id: 's1' }, { ts: 100 });
    const body = JSON.parse(mockClient.publish.mock.calls[0][1]);
    expect(body).toEqual({
      temperature: null, humidity: null, dewpoint: null, vpd: null,
      battery_voltage: null, rssi: null, last_seen: 100,
    });
  });

  it('ignores publishReading without a sensor id', () => {
    publishReading({}, READING);
    expect(mockClient.publish).not.toHaveBeenCalled();
  });
});

describe('publishDiscovery — HA configs', () => {
  beforeEach(() => {
    connect({ url: 'mqtt://broker.lan' });
    handlers.connect();
  });

  it('publishes five discovery messages per sensor (one per metric)', () => {
    publishDiscovery([SENSOR]);
    expect(mockClient.publish).toHaveBeenCalledTimes(5);
    const topics = mockClient.publish.mock.calls.map(c => c[0]);
    expect(topics).toEqual([
      'homeassistant/sensor/abc.123_temperature/config',
      'homeassistant/sensor/abc.123_humidity/config',
      'homeassistant/sensor/abc.123_dewpoint/config',
      'homeassistant/sensor/abc.123_vpd/config',
      'homeassistant/sensor/abc.123_battery/config',
    ]);
    for (const [, , opts] of mockClient.publish.mock.calls) {
      expect(opts).toEqual({ qos: 0, retain: true });
    }
  });

  it('groups all metrics under a single HA device via identifiers + via_device', () => {
    publishDiscovery([SENSOR]);
    const bodies = mockClient.publish.mock.calls.map(c => JSON.parse(c[1]));
    for (const b of bodies) {
      expect(b.device).toMatchObject({
        identifiers: ['sensorpush_abc.123'],
        name:        'Crawlspace',
        manufacturer:'SensorPush',
        model:       'HT1',
        via_device:  'sensorpush-recorder',
      });
    }
    // unique_ids are distinct per metric
    const uids = bodies.map(b => b.unique_id);
    expect(new Set(uids).size).toBe(bodies.length);
  });

  it('temperature config carries the right device_class, unit, and value_template', () => {
    publishDiscovery([SENSOR]);
    const temp = JSON.parse(mockClient.publish.mock.calls[0][1]);
    expect(temp).toMatchObject({
      name:                'Temperature',
      unique_id:           'sensorpush_abc.123_temperature',
      state_topic:         'sensorpush/abc.123/state',
      value_template:      '{{ value_json.temperature }}',
      device_class:        'temperature',
      state_class:         'measurement',
      unit_of_measurement: '°F',
    });
  });

  it('battery config maps to value_json.battery_voltage (not value_json.battery)', () => {
    publishDiscovery([SENSOR]);
    const battery = JSON.parse(mockClient.publish.mock.calls[4][1]);
    expect(battery.value_template).toBe('{{ value_json.battery_voltage }}');
    expect(battery.device_class).toBe('voltage');
    expect(battery.unit_of_measurement).toBe('V');
  });

  it('omits device_class for VPD (no HA-standard class)', () => {
    publishDiscovery([SENSOR]);
    const vpd = JSON.parse(mockClient.publish.mock.calls[3][1]);
    expect(vpd.device_class).toBeUndefined();
    expect(vpd.unit_of_measurement).toBe('kPa');
  });

  it('publishes 5×N messages for N sensors', () => {
    publishDiscovery([SENSOR, { id: 's2', name: 'Attic' }]);
    expect(mockClient.publish).toHaveBeenCalledTimes(10);
  });

  it('honors a custom MQTT_DISCOVERY_PREFIX', () => {
    _resetMqttState();
    process.env.MQTT_URL              = 'mqtt://broker.lan';
    process.env.MQTT_DISCOVERY_PREFIX = 'ha/';
    connect();
    handlers.connect();
    publishDiscovery([SENSOR]);
    expect(mockClient.publish.mock.calls[0][0]).toBe('ha/sensor/abc.123_temperature/config');
  });

  it('skips entries without an id rather than crashing', () => {
    publishDiscovery([{ name: 'no id here' }, SENSOR]);
    // only SENSOR's 5 publishes
    expect(mockClient.publish).toHaveBeenCalledTimes(5);
  });

  it('ignores non-array input', () => {
    publishDiscovery(null);
    publishDiscovery(undefined);
    publishDiscovery({});
    expect(mockClient.publish).not.toHaveBeenCalled();
  });
});

describe('disconnect', () => {
  it('ends the client and flips isConnected back to false', () => {
    connect({ url: 'mqtt://broker.lan' });
    handlers.connect();
    expect(isConnected()).toBe(true);
    disconnect();
    expect(mockClient.end).toHaveBeenCalled();
    expect(isConnected()).toBe(false);
  });

  it('is safe to call when never connected', () => {
    expect(() => disconnect()).not.toThrow();
  });

  it('subsequent publishes are no-ops after disconnect', () => {
    connect({ url: 'mqtt://broker.lan' });
    handlers.connect();
    const prevClient = mockClient;
    disconnect();
    publishReading(SENSOR, READING);
    expect(prevClient.publish).not.toHaveBeenCalled();
  });
});
