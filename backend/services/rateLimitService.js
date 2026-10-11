const { db } = require('./database');

function createRateLimiter({ name, windowMs, maxRequests }) {
  if (!name || !Number.isSafeInteger(windowMs) || windowMs < 1000 ||
    !Number.isSafeInteger(maxRequests) || maxRequests < 1) {
    throw new Error('Rate limiter requires a name, a window of at least one second, and a positive request limit.');
  }

  const increment = db.transaction((bucketKey, windowStart) => {
    db.prepare(`
      INSERT INTO rate_limit_buckets (bucket_key, window_start, request_count)
      VALUES (?, ?, 1)
      ON CONFLICT(bucket_key) DO UPDATE SET
        request_count = CASE
          WHEN window_start = excluded.window_start THEN request_count + 1
          ELSE 1
        END,
        window_start = excluded.window_start
    `).run(bucketKey, windowStart);
    return db.prepare(`
      SELECT request_count FROM rate_limit_buckets WHERE bucket_key = ?
    `).get(bucketKey).request_count;
  });

  return function rateLimit(req, res, next) {
    const now = Date.now();
    const windowStart = Math.floor(now / windowMs) * windowMs;
    const address = String(req.ip || req.socket?.remoteAddress || 'unknown').slice(0, 128);
    const bucketKey = `${name}:${address}`;
    try {
      const count = increment.immediate(bucketKey, windowStart);
      const remaining = Math.max(0, maxRequests - count);
      const retryAfterSeconds = Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000));
      res.setHeader('RateLimit-Limit', String(maxRequests));
      res.setHeader('RateLimit-Remaining', String(remaining));
      res.setHeader('RateLimit-Reset', String(retryAfterSeconds));
      if (count > maxRequests) {
        res.setHeader('Retry-After', String(retryAfterSeconds));
        return res.status(429).json({ error: 'Too many requests. Please retry after the rate limit resets.' });
      }
      if (Math.random() < 0.01) {
        db.prepare('DELETE FROM rate_limit_buckets WHERE window_start < ?')
          .run(now - 24 * 60 * 60 * 1000);
      }
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

module.exports = { createRateLimiter };
