// Shared fixtures for the Xiaomi/Roborock integration tests.

// A miIO device token: 16 bytes = 32 hex characters.
export const TOKEN_HEX = '00112233445566778899aabbccddeeff';
export const DID = '123456789';

// A raw Mi Home device entry (as returned by /home/device_list -> result.list).
export const MI_DEVICE = {
  did: DID,
  name: 'Robot salon',
  model: 'roborock.vacuum.a15',
  token: TOKEN_HEX,
  localip: '127.0.0.1',
  mac: 'AA:BB:CC:DD:EE:FF',
  isOnline: true,
  ssid: 'home-wifi',
};

// A non-vacuum device that must be ignored by the discovery filter.
export const MI_OTHER_DEVICE = {
  did: '987654321',
  name: 'Lampe',
  model: 'yeelink.light.bslamp2',
  token: 'ffffffffffffffffffffffffffffffff',
  isOnline: true,
};

// A realistic get_status result (single element of the miIO result array).
export const STATUS = {
  msg_ver: 2,
  state: 8, // charging
  battery: 87,
  clean_time: 0,
  clean_area: 0,
  error_code: 0,
  fan_power: 102, // balanced
  in_cleaning: 0,
  in_returning: 0,
};

// Xiaomi login secret (base64) used by the fake cloud in tests.
export const SSECURITY = Buffer.from('0123456789abcdef').toString('base64');
