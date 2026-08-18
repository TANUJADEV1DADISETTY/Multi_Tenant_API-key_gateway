const crypto = require('crypto');

/**
 * Generates a cryptographically secure API key.
 * Format: sk_live_<base64url_string>
 */
function generateApiKey() {
  const randomBuffer = crypto.randomBytes(32);
  const base64UrlString = randomBuffer.toString('base64url');
  const prefix = 'sk_live_';
  const fullApiKey = `${prefix}${base64UrlString}`;
  const lastFour = fullApiKey.slice(-4);
  const keyHash = hashApiKey(fullApiKey);

  return {
    fullApiKey,
    keyHash,
    keyPrefix: prefix,
    lastFour,
  };
}

/**
 * Computes SHA-256 cryptographic hash of a raw API key string.
 */
function hashApiKey(rawKey) {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

module.exports = {
  generateApiKey,
  hashApiKey,
};
