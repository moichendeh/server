const jwt = require('jsonwebtoken');
const db = require('../db');

const COOKIE_NAME = 'ss_token';

// Returns the logged-in user's info from the cookie, or null if there isn't a valid,
// still-active (not logged-out) session. Shared by every place that needs to know
// "who, if anyone, is making this request".
async function currentUser(req) {
    const token = req.cookies[COOKIE_NAME];
    if (!token) return null;
    let payload;
    try {
        payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch (e) {
        return null;
    }
    const row = await db.prepare(
        'SELECT u.is_disabled FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?'
    ).get(payload.jti);
    if (!row || row.is_disabled) return null; // logged out, OR the account was disabled since this cookie was issued
    return payload;
}

async function requireAuth(req, res, next) {
    try {
        const user = await currentUser(req);
        if (!user) return res.status(401).json({ ok: false, error: 'Please log in.' });
        req.user = user;
        next();
    } catch (e) { next(e); }
}

function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.user || !roles.includes(req.user.role)) {
            return res.status(403).json({ ok: false, error: 'You do not have permission to do that.' });
        }
        next();
    };
}

module.exports = { requireAuth, requireRole, currentUser, COOKIE_NAME };
