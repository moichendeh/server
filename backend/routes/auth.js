const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const asyncHandler = require('../middleware/asyncHandler');
const isAdminEmail = require('../lib/isAdminEmail');
const { authLimiter } = require('../middleware/rateLimit');
const { requireAuth, COOKIE_NAME } = require('../middleware/auth');

const router = express.Router();
const COOKIE_OPTS = {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 60 * 60 * 1000
};

async function signCookie(res, user) {
    const jti = crypto.randomUUID();
    await db.prepare('INSERT INTO sessions (id, user_id) VALUES (?, ?)').run(jti, user.id);
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role, jti }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.cookie(COOKIE_NAME, token, COOKIE_OPTS);
}

// Any sermon/paragraph/mention left with no owner (from before this app had accounts
// at all) becomes visible to nobody - filtered out by every "WHERE user_id = ?" query.
// The moment a real Admin (per ADMIN_EMAILS) logs in, hand that old data to them.
async function claimOrphanedData(adminUserId) {
    await db.transaction(async tx => {
        await tx.prepare('UPDATE sermons SET user_id = ? WHERE user_id IS NULL').run(adminUserId);
        await tx.prepare('UPDATE paragraphs SET user_id = ? WHERE user_id IS NULL').run(adminUserId);
        await tx.prepare('UPDATE scripture_mentions SET user_id = ? WHERE user_id IS NULL').run(adminUserId);
    });
}

function isValidEmail(email) {
    return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

router.post('/register', authLimiter, asyncHandler(async (req, res) => {
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const privacyAccepted = req.body.privacyAccepted === true;

    if (!name) return res.status(400).json({ ok: false, error: 'Please enter your name.' });
    if (!isValidEmail(email)) return res.status(400).json({ ok: false, error: 'Please enter a valid email address.' });
    if (password.length < 10) return res.status(400).json({ ok: false, error: 'Password must be at least 10 characters.' });
    if (!privacyAccepted) return res.status(400).json({ ok: false, error: 'Please accept the privacy notice to continue.' });

    const existing = await db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) return res.status(409).json({ ok: false, error: 'An account with that email already exists.' });

    const role = isAdminEmail(email) ? 'admin' : 'user';
    const hash = bcrypt.hashSync(password, 10);
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    // Registering also signs them in right away, so it counts as their first login too -
    // otherwise the admin list would show "0 logins" for someone actively using the app.
    const info = await db.prepare(
        'INSERT INTO users (name, email, password_hash, role, privacy_accepted_at, last_login_at, login_count) VALUES (?, ?, ?, ?, ?, ?, 1) RETURNING id'
    ).run(name, email, hash, role, now, now);
    const user = { id: Number(info.lastInsertRowid), name, email, role };

    if (role === 'admin') await claimOrphanedData(user.id);
    await db.prepare('INSERT INTO login_events (user_id, user_agent) VALUES (?, ?)')
        .run(user.id, String(req.headers['user-agent'] || '').slice(0, 300));

    await signCookie(res, user);
    res.json({ ok: true, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
}));

router.post('/login', authLimiter, asyncHandler(async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const row = await db.prepare('SELECT id, name, email, password_hash, role, is_disabled FROM users WHERE email = ?').get(email);
    if (!row || !bcrypt.compareSync(password, row.password_hash)) {
        return res.status(401).json({ ok: false, error: 'Wrong email or password.' });
    }
    if (row.is_disabled) {
        return res.status(403).json({ ok: false, error: 'This account has been disabled.' });
    }

    // Admin status always comes fresh from ADMIN_EMAILS, in case it changed since they
    // last logged in - never trust whatever role happens to be stored.
    const role = isAdminEmail(row.email) ? 'admin' : 'user';
    if (role !== row.role) await db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, row.id);
    if (role === 'admin') await claimOrphanedData(row.id);

    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    await db.prepare('UPDATE users SET last_login_at = ?, login_count = login_count + 1 WHERE id = ?').run(now, row.id);
    await db.prepare('INSERT INTO login_events (user_id, user_agent) VALUES (?, ?)')
        .run(row.id, String(req.headers['user-agent'] || '').slice(0, 300));

    const user = { id: row.id, name: row.name, email: row.email, role };
    await signCookie(res, user);
    res.json({ ok: true, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
}));

router.post('/logout', asyncHandler(async (req, res) => {
    const token = req.cookies[COOKIE_NAME];
    if (token) {
        try { await db.prepare('DELETE FROM sessions WHERE id = ?').run(jwt.decode(token).jti); } catch (e) { /* malformed token, nothing to clean up */ }
    }
    res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
    res.json({ ok: true });
}));

router.get('/me', requireAuth, asyncHandler(async (req, res) => {
    const row = await db.prepare('SELECT name FROM users WHERE id = ?').get(req.user.id);
    res.json({ ok: true, user: { id: req.user.id, name: row ? row.name : '', email: req.user.email, role: req.user.role } });
}));

module.exports = router;
module.exports.claimOrphanedData = claimOrphanedData;
