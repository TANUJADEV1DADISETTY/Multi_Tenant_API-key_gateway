const Redis = require('ioredis');

let isRedisConnected = false;

const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  lazyConnect: true,
  maxRetriesPerRequest: 1,
  retryStrategy() {
    return null; // Don't loop infinitely if Redis is offline locally
  },
});

redis.on('connect', () => {
  isRedisConnected = true;
  console.log('Connected to Redis server');
});

redis.on('error', (err) => {
  isRedisConnected = false;
});

// Attempt initial non-blocking connection
redis.connect().catch(() => {
  console.log('ℹ️ Redis not reachable locally. Falling back to in-memory Sorted Set Sliding Window Limiter.');
});

module.exports = redis;
