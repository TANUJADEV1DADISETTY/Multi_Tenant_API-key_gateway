# Multi-Tenant API Key Gateway with Redis Rate Limiting & Rotation

A secure, high-performance, multi-tenant API key management gateway built with **Node.js/Express**, **PostgreSQL**, **Redis**, and **Docker Compose**.

It implements essential enterprise security patterns including SHA-256 API key hashing, custom Redis sorted-set sliding-window rate limiting, graceful key rotation with a 60-second migration window, and audit logging.

---

## 🚀 Key Features & Architecture

1. **Cryptographic API Key Lifecycle**:
   - Keys are generated as Base64 URL-safe strings prepended with `sk_live_`.
   - Plaintext key is returned **only once** upon creation.
   - Database stores strictly the **SHA-256 hash** (`key_hash`), non-secret prefix (`key_prefix`), and `last_four` characters.

2. **Custom Redis Sliding-Window Rate Limiter**:
   - Built from first principles without external libraries using Redis **Sorted Sets** (`ZREMRANGEBYSCORE`, `ZADD`, `ZCARD`, `EXPIRE`).
   - Executed inside an atomic **`MULTI` / `EXEC`** transaction block.
   - Automatically calculates exact **`Retry-After`** HTTP response header (in seconds) when rate limits are exceeded.

3. **1-Minute Key Rotation Grace Period**:
   - Rotating a key issues a new plaintext API key and marks the old key with `expires_at = NOW() + INTERVAL '1 minute'`.
   - During the 60-second grace period, requests with both old and new keys succeed (`200 OK`).
   - After 60 seconds, requests with the old key fail automatically with `401 Unauthorized`.

4. **Persistent Audit Logging**:
   - Every authenticated request to `/api/protected` is persisted to PostgreSQL in the `audit_logs` table (`api_key_id`, `endpoint`, `status_code`, `timestamp`).

5. **Interactive Management & Audit Console**:
   - Embedded web UI at `http://localhost:3000` with key creation, key rotation, key revocation, burst request simulator, Chart.js analytics, and audit log table.

---

## 🛠️ API Contracts

| Method | Endpoint | Description | Status Code |
|---|---|---|---|
| `POST` | `/api/tenants/:tenantId/keys` | Issue new API key (`{ "rateLimitPerMinute": 100 }`) | `201 Created` |
| `GET` | `/api/tenants/:tenantId/keys` | List tenant keys (masked: `sk_live_...3t94`) | `200 OK` |
| `GET` | `/api/protected` | Protected endpoint (`Authorization: Bearer <key>`) | `200` / `401` / `429` |
| `DELETE` | `/api/keys/:keyId` | Revoke API key immediately (`is_active = false`) | `204 No Content` |
| `POST` | `/api/keys/:keyId/rotate` | Rotate key with 1-minute grace period | `200 OK` |
| `GET` | `/api/audit-logs` | Fetch real-time system audit trail | `200 OK` |
| `GET` | `/health` | Healthcheck endpoint for Docker & system monitoring | `200 OK` |

---

## 🐳 Quick Start with Docker Compose

Run the entire application stack (API Gateway, PostgreSQL, and Redis) with a single command:

```bash
docker-compose up --build
```

### Verification & Health:
- Access the **Interactive Console UI**: [http://localhost:3000](http://localhost:3000)
- Check API Health: `curl http://localhost:3000/health`

---

## 🧪 Testing the Core Requirements

### 1. Issue an API Key:
```bash
curl -X POST http://localhost:3000/api/tenants/1/keys \
  -H "Content-Type: application/json" \
  -d '{"rateLimitPerMinute": 5}'
```

### 2. Make Authenticated Request:
```bash
curl -i http://localhost:3000/api/protected \
  -H "Authorization: Bearer <YOUR_API_KEY>"
```

### 3. Test Rate Limiting (5 req/min):
Fire 6 requests in quick succession.
- Requests 1 to 5 -> `200 OK`
- Request 6 -> `429 Too Many Requests` with response header `Retry-After: 60`

### 4. Rotate Key with 1-Minute Grace Period:
```bash
curl -X POST http://localhost:3000/api/keys/<KEY_ID>/rotate
```
- For 60 seconds: Both old and new keys return `200 OK`.
- After 65 seconds: Old key returns `401 Unauthorized`, new key returns `200 OK`.

---

## 📂 Project Structure

```
├── docker-compose.yml       # Orchestrates api, db (PostgreSQL), and redis
├── Dockerfile               # Node.js 20 production container
├── init.sql                 # PostgreSQL tables & seed data script
├── package.json             # App dependencies (express, ioredis, pg)
├── .env.example             # Documented environment variables
├── src/
│   ├── app.js               # Express REST server & endpoints
│   ├── middleware.js        # Bearer token auth middleware
│   ├── rateLimiter.js       # Redis sliding window sorted-set logic
│   ├── cryptoUtils.js       # Base64URL key generator & SHA-256 hashing
│   ├── db.js                # PostgreSQL pool connector
│   └── redis.js             # ioredis client setup
└── public/                  # Frontend Console (HTML, CSS, JS, Chart.js)
```
