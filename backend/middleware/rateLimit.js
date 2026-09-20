const rateLimit = require('express-rate-limit');

// Slows down password-guessing scripts without getting in a real person's way -
// nobody legitimately needs more than this many login/register attempts in 15 minutes.
// Skipped only when a test suite explicitly asks for it (RATE_LIMIT_DISABLED=1) - an
// automated test that registers/logs in dozens of times in a few seconds looks
// exactly like the thing this is supposed to stop, from the outside. Real deployments
// (Render) never set this variable, so the limit is always on in production.
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => process.env.RATE_LIMIT_DISABLED === '1',
    message: { ok: false, error: 'Too many attempts. Please wait a few minutes and try again.' }
});

module.exports = { authLimiter };
