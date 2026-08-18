const db = require('./db');
const { hashApiKey } = require('./cryptoUtils');

/**
 * Authentication Middleware for protected endpoints.
 * Validates Authorization: Bearer <apiKey> header against PostgreSQL api_keys table.
 */
async function authenticateApiKey(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing or malformed Authorization header. Expected Bearer <apiKey>.',
    });
  }

  const rawApiKey = authHeader.substring(7).trim();
  if (!rawApiKey) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Empty API key provided.',
    });
  }

  try {
    const keyHash = hashApiKey(rawApiKey);

    const query = `
      SELECT ak.id, ak.tenant_id, ak.key_prefix, ak.last_four, ak.rate_limit_per_minute, ak.is_active, ak.expires_at, t.name AS tenant_name
      FROM api_keys ak
      JOIN tenants t ON ak.tenant_id = t.id
      WHERE ak.key_hash = $1
        AND ak.is_active = TRUE
        AND (ak.expires_at IS NULL OR ak.expires_at > NOW())
    `;

    const { rows } = await db.query(query, [keyHash]);

    if (rows.length === 0) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid, inactive, or expired API key.',
      });
    }

    const keyRecord = rows[0];
    req.apiKey = keyRecord;
    req.tenant = {
      id: keyRecord.tenant_id,
      name: keyRecord.tenant_name,
    };

    next();
  } catch (err) {
    console.error('Authentication Error:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

module.exports = {
  authenticateApiKey,
};
