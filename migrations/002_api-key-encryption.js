// 002_api-key-encryption.js — Document the encryption format on user_api_keys.api_key

exports.up = (pgm) => {
  pgm.sql(`COMMENT ON COLUMN user_api_keys.api_key IS 'AES-256-GCM encrypted when API_KEY_ENCRYPTION_KEY is set. Format: enc:iv:tag:ciphertext'`);
};

exports.down = (pgm) => {
  pgm.sql(`COMMENT ON COLUMN user_api_keys.api_key IS NULL`);
};
