const http = require('http');

const BASE_URL = 'http://localhost:3000';

function request(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const reqHeaders = {
      'Content-Type': 'application/json',
      ...headers,
    };

    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: reqHeaders,
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        let parsed = null;
        try {
          parsed = data ? JSON.parse(data) : null;
        } catch (e) {
          parsed = data;
        }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: parsed,
        });
      });
    });

    req.on('error', (err) => reject(err));

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function runTests() {
  console.log('🧪 Starting Multi-Tenant API Gateway Contract Test Suite...\n');
  let passed = 0;
  let failed = 0;

  function assert(condition, testName) {
    if (condition) {
      console.log(`  ✅ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${testName}`);
      failed++;
    }
  }

  try {
    // Test 1: Healthcheck
    const health = await request('GET', '/health');
    assert(health.status === 200 && health.body.status === 'ok', '1. Health Check GET /health returns 200 OK');

    // Test 2: Issue API Key with rate limit 5
    const issueRes = await request('POST', '/api/tenants/1/keys', { rateLimitPerMinute: 5 });
    assert(
      issueRes.status === 201 &&
        issueRes.body.apiKey &&
        issueRes.body.apiKey.startsWith('sk_live_') &&
        issueRes.body.keyRecord.id,
      '2. Issue API Key POST /api/tenants/1/keys returns 201 with plaintext key'
    );

    const apiKey1 = issueRes.body.apiKey;
    const keyId1 = issueRes.body.keyRecord.id;

    // Test 3: List API Keys masked
    const listRes = await request('GET', '/api/tenants/1/keys');
    assert(
      listRes.status === 200 &&
        Array.isArray(listRes.body) &&
        listRes.body.some((k) => k.id === keyId1 && k.maskedKey.startsWith('sk_live_...')),
      '3. List API Keys GET /api/tenants/1/keys returns 200 with masked keys'
    );

    // Test 4: Authenticated Request (200 OK)
    const authRes = await request('GET', '/api/protected', null, {
      Authorization: `Bearer ${apiKey1}`,
    });
    assert(authRes.status === 200 && authRes.body.message, '4. GET /api/protected with valid Bearer key returns 200 OK');

    // Test 5: Invalid Key Authentication (401 Unauthorized)
    const invalidAuthRes = await request('GET', '/api/protected', null, {
      Authorization: 'Bearer sk_live_invalidkey1234567890',
    });
    assert(invalidAuthRes.status === 401, '5. GET /api/protected with invalid key returns 401 Unauthorized');

    // Test 6: Rate Limiting Enforcement (5 req/min -> 6th returns 429 & Retry-After header)
    console.log('\n  ⚡ Testing Rate Limiting (5 allowed in window)...');
    let hit429 = false;
    let retryAfterHeader = null;

    // Requests 2, 3, 4, 5 (req 1 already sent above)
    for (let i = 2; i <= 6; i++) {
      const res = await request('GET', '/api/protected', null, {
        Authorization: `Bearer ${apiKey1}`,
      });
      if (res.status === 429) {
        hit429 = true;
        retryAfterHeader = res.headers['retry-after'];
      }
    }
    assert(
      hit429 && retryAfterHeader && parseInt(retryAfterHeader, 10) > 0,
      '6. Rate limiting triggers 429 Too Many Requests with valid Retry-After header on 6th request'
    );

    // Test 7: API Key Revocation
    console.log('\n  ⚡ Testing Key Revocation...');
    const issueRevokeRes = await request('POST', '/api/tenants/1/keys', { rateLimitPerMinute: 100 });
    const keyToRevoke = issueRevokeRes.body.apiKey;
    const keyIdToRevoke = issueRevokeRes.body.keyRecord.id;

    // Verify key works
    const preRevokeAuth = await request('GET', '/api/protected', null, { Authorization: `Bearer ${keyToRevoke}` });
    assert(preRevokeAuth.status === 200, '7a. New key works prior to revocation');

    // Revoke key
    const deleteRes = await request('DELETE', `/api/keys/${keyIdToRevoke}`);
    assert(deleteRes.status === 204, '7b. DELETE /api/keys/:keyId returns 204 No Content');

    // Verify key is unauthorized
    const postRevokeAuth = await request('GET', '/api/protected', null, { Authorization: `Bearer ${keyToRevoke}` });
    assert(postRevokeAuth.status === 401, '7c. Revoked key immediately returns 401 Unauthorized');

    // Test 8: API Key Rotation with Grace Period
    console.log('\n  ⚡ Testing Key Rotation with 1-Minute Grace Period...');
    const issueRotateRes = await request('POST', '/api/tenants/1/keys', { rateLimitPerMinute: 100 });
    const oldKey = issueRotateRes.body.apiKey;
    const oldKeyId = issueRotateRes.body.keyRecord.id;

    const rotateRes = await request('POST', `/api/keys/${oldKeyId}/rotate`);
    assert(
      rotateRes.status === 200 && rotateRes.body.newApiKey && rotateRes.body.newApiKey.startsWith('sk_live_'),
      '8a. POST /api/keys/:keyId/rotate returns 200 with newApiKey'
    );

    const newKey = rotateRes.body.newApiKey;

    // Both old and new keys should work during grace period
    const oldKeyGrace = await request('GET', '/api/protected', null, { Authorization: `Bearer ${oldKey}` });
    const newKeyGrace = await request('GET', '/api/protected', null, { Authorization: `Bearer ${newKey}` });

    assert(
      oldKeyGrace.status === 200 && newKeyGrace.status === 200,
      '8b. Both old and new keys return 200 OK during grace period'
    );

    // Test 9: Audit Logs Recording
    console.log('\n  ⚡ Testing Audit Logs persistence...');
    const auditRes = await request('GET', '/api/audit-logs');
    assert(
      auditRes.status === 200 &&
        Array.isArray(auditRes.body) &&
        auditRes.body.some((log) => log.statusCode === 200) &&
        auditRes.body.some((log) => log.statusCode === 429),
      '9. Audit log records both 200 OK and 429 Too Many Requests events'
    );

    console.log(`\n====================================================`);
    console.log(`🎯 Test Summary: ${passed} PASSED, ${failed} FAILED`);
    console.log(`====================================================\n`);
  } catch (err) {
    console.error('Test execution error:', err);
  }
}

runTests();
