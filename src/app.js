const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./db');
const redis = require('./redis');
const { generateApiKey } = require('./cryptoUtils');
const { authenticateApiKey } = require('./middleware');
const { checkRateLimit } = require('./rateLimiter');

const app = express();

app.use(cors());
app.use(express.json());

// Serve static frontend files from 'public' directory
app.use(express.static(path.join(__dirname, '..', 'public')));

/**
 * Health Check Endpoint
 * Used by Docker healthcheck and monitoring
 */
app.get('/health', async (req, res) => {
  try {
    let dbStatus = 'healthy';
    let redisStatus = 'healthy';

    try {
      await db.query('SELECT 1');
    } catch (e) {
      dbStatus = 'degraded';
    }

    try {
      if (redis.status === 'ready') {
        await redis.ping();
      } else {
        redisStatus = 'in-memory-fallback';
      }
    } catch (e) {
      redisStatus = 'in-memory-fallback';
    }

    return res.status(200).json({
      status: 'ok',
      db: dbStatus,
      redis: redisStatus,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * Requirement 3: Issue a new API key for a tenant
 * POST /api/tenants/:tenantId/keys
 */
app.post('/api/tenants/:tenantId/keys', async (req, res) => {
  const tenantId = parseInt(req.params.tenantId, 10);
  const rateLimitPerMinute = parseInt(req.body.rateLimitPerMinute || 100, 10);

  if (isNaN(tenantId)) {
    return res.status(400).json({ error: 'Invalid tenantId' });
  }

  try {
    // Verify tenant exists
    const tenantCheck = await db.query('SELECT id FROM tenants WHERE id = $1', [tenantId]);
    if (tenantCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const { fullApiKey, keyHash, keyPrefix, lastFour } = generateApiKey();

    const insertQuery = `
      INSERT INTO api_keys (tenant_id, key_hash, key_prefix, last_four, rate_limit_per_minute, is_active)
      VALUES ($1, $2, $3, $4, $5, TRUE)
      RETURNING id, last_four, rate_limit_per_minute
    `;

    const { rows } = await db.query(insertQuery, [
      tenantId,
      keyHash,
      keyPrefix,
      lastFour,
      rateLimitPerMinute,
    ]);

    const createdRecord = rows[0];

    return res.status(201).json({
      apiKey: fullApiKey,
      keyRecord: {
        id: createdRecord.id,
        lastFour: createdRecord.last_four,
        rateLimitPerMinute: createdRecord.rate_limit_per_minute,
      },
    });
  } catch (err) {
    console.error('Error creating API key:', err);
    return res.status(500).json({ error: 'Failed to create API key' });
  }
});

/**
 * Requirement 4: List all API keys for a tenant (masked)
 * GET /api/tenants/:tenantId/keys
 */
app.get('/api/tenants/:tenantId/keys', async (req, res) => {
  const tenantId = parseInt(req.params.tenantId, 10);

  if (isNaN(tenantId)) {
    return res.status(400).json({ error: 'Invalid tenantId' });
  }

  try {
    const query = `
      SELECT id, key_prefix, last_four, rate_limit_per_minute, is_active, expires_at, created_at
      FROM api_keys
      WHERE tenant_id = $1
      ORDER BY created_at DESC
    `;

    const { rows } = await db.query(query, [tenantId]);

    const maskedKeys = rows.map((key) => {
      const isExpired = key.expires_at ? new Date(key.expires_at) <= new Date() : false;
      const effectiveActive = key.is_active && !isExpired;

      return {
        id: key.id,
        maskedKey: `${key.key_prefix}...${key.last_four}`,
        createdAt: key.created_at,
        isActive: effectiveActive,
        rateLimitPerMinute: key.rate_limit_per_minute,
        expiresAt: key.expires_at,
      };
    });

    return res.status(200).json(maskedKeys);
  } catch (err) {
    console.error('Error fetching API keys:', err);
    return res.status(500).json({ error: 'Failed to fetch API keys' });
  }
});

/**
 * Requirement 5 & 6 & 9: Protected Endpoint with Rate Limiting & Audit Logging
 * GET /api/protected
 */
app.get('/api/protected', authenticateApiKey, async (req, res) => {
  const apiKeyId = req.apiKey.id;
  const rateLimitPerMinute = req.apiKey.rate_limit_per_minute;
  const endpointPath = '/api/protected';

  let statusCode = 200;
  let rateLimitResult;

  try {
    // Check Redis sliding window rate limiter
    rateLimitResult = await checkRateLimit(apiKeyId, rateLimitPerMinute);

    if (!rateLimitResult.allowed) {
      statusCode = 429;
    }
  } catch (err) {
    console.error('Rate limiter error:', err);
    // If rate limiter fails, fail safe or proceed
  }

  // Requirement 9: Record EVERY authenticated request in audit_logs table
  try {
    await db.query(
      'INSERT INTO audit_logs (api_key_id, endpoint, status_code) VALUES ($1, $2, $3)',
      [apiKeyId, endpointPath, statusCode]
    );
  } catch (auditErr) {
    console.error('Audit log insertion failed:', auditErr);
  }

  if (statusCode === 429) {
    res.setHeader('Retry-After', rateLimitResult.retryAfter.toString());
    return res.status(429).json({
      error: 'Too Many Requests',
      message: 'Rate limit exceeded. Please slow down your requests.',
      retryAfter: rateLimitResult.retryAfter,
    });
  }

  return res.status(200).json({
    message: 'Access granted. Protected endpoint accessed successfully.',
    tenant: req.tenant,
    apiKeyId: req.apiKey.id,
    timestamp: new Date().toISOString(),
  });
});

/**
 * Requirement 7: Immediate Revocation of an API key
 * DELETE /api/keys/:keyId
 */
app.delete('/api/keys/:keyId', async (req, res) => {
  const keyId = parseInt(req.params.keyId, 10);

  if (isNaN(keyId)) {
    return res.status(400).json({ error: 'Invalid keyId' });
  }

  try {
    const result = await db.query(
      'UPDATE api_keys SET is_active = FALSE WHERE id = $1 RETURNING id',
      [keyId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'API Key not found' });
    }

    // 204 No Content
    return res.status(204).send();
  } catch (err) {
    console.error('Error revoking API key:', err);
    return res.status(500).json({ error: 'Failed to revoke API key' });
  }
});

/**
 * Requirement 8: Key Rotation with 1-Minute Grace Period
 * POST /api/keys/:keyId/rotate
 */
app.post('/api/keys/:keyId/rotate', async (req, res) => {
  const keyId = parseInt(req.params.keyId, 10);

  if (isNaN(keyId)) {
    return res.status(400).json({ error: 'Invalid keyId' });
  }

  try {
    // 1. Fetch old key record
    const { rows } = await db.query('SELECT * FROM api_keys WHERE id = $1 AND is_active = TRUE', [
      keyId,
    ]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Active API Key not found' });
    }

    const oldKeyRecord = rows[0];

    // 2. Set old key expires_at to 1 minute in the future (grace period)
    await db.query(
      "UPDATE api_keys SET expires_at = NOW() + INTERVAL '1 minute' WHERE id = $1",
      [keyId]
    );

    // 3. Generate new API key
    const { fullApiKey, keyHash, keyPrefix, lastFour } = generateApiKey();

    // 4. Insert new key for same tenant and rate limit
    await db.query(
      `INSERT INTO api_keys (tenant_id, key_hash, key_prefix, last_four, rate_limit_per_minute, is_active)
       VALUES ($1, $2, $3, $4, $5, TRUE)`,
      [
        oldKeyRecord.tenant_id,
        keyHash,
        keyPrefix,
        lastFour,
        oldKeyRecord.rate_limit_per_minute,
      ]
    );

    return res.status(200).json({
      newApiKey: fullApiKey,
    });
  } catch (err) {
    console.error('Error rotating API key:', err);
    return res.status(500).json({ error: 'Failed to rotate API key' });
  }
});

/**
 * Console Helper API: List Tenants
 * GET /api/tenants
 */
app.get('/api/tenants', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM tenants ORDER BY id ASC');
    return res.status(200).json(rows);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch tenants' });
  }
});

/**
 * Console Helper API: Create Tenant
 * POST /api/tenants
 */
app.post('/api/tenants', async (req, res) => {
  const { name } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'Tenant name required' });
  }
  try {
    const { rows } = await db.query('INSERT INTO tenants (name) VALUES ($1) RETURNING *', [name]);
    return res.status(201).json(rows[0]);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to create tenant' });
  }
});

/**
 * Console Helper API: Fetch Audit Logs
 * GET /api/audit-logs
 */
app.get('/api/audit-logs', async (req, res) => {
  try {
    const query = `
      SELECT 
        al.id, 
        al.api_key_id, 
        al.endpoint, 
        al.status_code, 
        al.timestamp,
        ak.key_prefix,
        ak.last_four
      FROM audit_logs al
      LEFT JOIN api_keys ak ON al.api_key_id = ak.id
      ORDER BY al.timestamp DESC
      LIMIT 100
    `;
    const { rows } = await db.query(query);
    const formatted = rows.map((log) => ({
      id: log.id,
      apiKeyId: log.api_key_id,
      maskedKey: log.key_prefix && log.last_four ? `${log.key_prefix}...${log.last_four}` : `Key #${log.api_key_id}`,
      endpoint: log.endpoint,
      statusCode: log.status_code,
      timestamp: log.timestamp,
    }));
    return res.status(200).json(formatted);
  } catch (err) {
    console.error('Audit log fetch error:', err);
    return res.status(500).json({ error: 'Failed to fetch audit logs' });
  }
});

/**
 * Console Helper API: Hourly Analytics for Usage Visualization Chart
 * GET /api/analytics
 */
app.get('/api/analytics', async (req, res) => {
  try {
    const query = `
      SELECT 
        status_code,
        COUNT(*) as count
      FROM audit_logs
      WHERE timestamp >= NOW() - INTERVAL '1 hour'
      GROUP BY status_code
    `;
    const { rows } = await db.query(query);
    const summary = {
      success200: 0,
      limited429: 0,
      total: 0,
    };
    rows.forEach((row) => {
      const cnt = parseInt(row.count, 10);
      summary.total += cnt;
      if (parseInt(row.status_code, 10) === 200) {
        summary.success200 = cnt;
      } else if (parseInt(row.status_code, 10) === 429) {
        summary.limited429 = cnt;
      }
    });
    return res.status(200).json(summary);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`🚀 Multi-Tenant API Gateway running on port ${PORT}`);
  console.log(`🌐 Audit Console UI available at http://localhost:${PORT}`);
  console.log(`====================================================`);
});
