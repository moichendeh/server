const jwt = require('jsonwebtoken');
const db = require('../db');

const COOKIE_NAME = 'ss_token';

// Returns the logged-in user's info from the cookie, or null if there isn't a valid,
// still-active (not logged-out) session. Shared by every place that needs to know
// "who, if anyone, is making this request".
function currentUser(req) {
    const token = req.cookies[COOKIE_NAME];
    if (!token) return null;
    let payload;
    try {
        payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch (e) {
        return null;
    }
    if (!db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(payload.jti)) return null;
    return payload;
}

function requireAuth(req, res, next) {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ ok: false, error: 'Please log in.' });
    req.user = user;
    next();
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
