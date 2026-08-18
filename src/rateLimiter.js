const redis = require('./redis');

// In-Memory Sorted Set Store for local standalone execution when Redis is offline
const inMemorySortedSets = new Map();

/**
 * Sliding Window Rate Limiter using Redis Sorted Sets (with in-memory fallback).
 * 
 * Executed via Redis MULTI / EXEC transaction when Redis is connected.
 * 
 * @param {number|string} apiKeyId - Database ID of the API key
 * @param {number} limitPerMinute - Maximum allowed requests per 60-second window
 * @returns {Promise<{ allowed: boolean, count: number, limit: number, retryAfter: number }>}
 */
async function checkRateLimit(apiKeyId, limitPerMinute) {
  const windowMs = 60 * 1000; // 60 seconds
  const now = Date.now();
  const clearBefore = now - windowMs;
  const redisKey = `rate_limit:${apiKeyId}`;
  const member = `${now}-${Math.random().toString(36).substring(2, 9)}`;

  // If Redis is ready, use Redis MULTI / EXEC transaction
  if (redis.status === 'ready') {
    try {
      const multi = redis.multi();
      multi.zremrangebyscore(redisKey, 0, clearBefore);
      multi.zadd(redisKey, now, member);
      multi.zcard(redisKey);
      multi.expire(redisKey, 60);

      const results = await multi.exec();

      if (results && results[2] && results[2][1] !== undefined) {
        const count = results[2][1];
        const allowed = count <= limitPerMinute;
        let retryAfter = 0;

        if (!allowed) {
          const oldest = await redis.zrange(redisKey, 0, 0, 'WITHSCORES');
          if (oldest && oldest.length >= 2) {
            const oldestScore = parseFloat(oldest[1]);
            const expiresAtMs = oldestScore + windowMs;
            retryAfter = Math.max(1, Math.ceil((expiresAtMs - now) / 1000));
          } else {
            retryAfter = 60;
          }
        }

        return { allowed, count, limit: limitPerMinute, retryAfter };
      }
    } catch (err) {
      console.warn('Redis transaction error, falling back to in-memory limiter:', err.message);
    }
  }

  // Standalone In-Memory Sorted Set Sliding Window Limiter
  if (!inMemorySortedSets.has(apiKeyId)) {
    inMemorySortedSets.set(apiKeyId, []);
  }

  let set = inMemorySortedSets.get(apiKeyId);
  // a. ZREMRANGEBYSCORE key 0 clearBefore
  set = set.filter((item) => item.score > clearBefore);
  // b. ZADD key currentTime member
  set.push({ score: now, member });
  inMemorySortedSets.set(apiKeyId, set);

  // c. ZCARD key
  const count = set.length;
  const allowed = count <= limitPerMinute;
  let retryAfter = 0;

  if (!allowed) {
    // Find score of oldest element
    const oldestScore = set[0].score;
    const expiresAtMs = oldestScore + windowMs;
    retryAfter = Math.max(1, Math.ceil((expiresAtMs - now) / 1000));
  }

  return {
    allowed,
    count,
    limit: limitPerMinute,
    retryAfter,
  };
}

module.exports = {
  checkRateLimit,
};
