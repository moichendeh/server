const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { requireAuth, currentUser, COOKIE_NAME } = require('../middleware/auth');

const router = express.Router();
const ROLES = ['admin', 'notetaker', 'media'];
const COOKIE_OPTS = { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000 };

function signCookie(res, user) {
    const jti = crypto.randomUUID();
    db.prepare('INSERT INTO sessions (id, user_id) VALUES (?, ?)').run(jti, user.id);
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role, jti }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.cookie(COOKIE_NAME, token, COOKIE_OPTS);
}

// Anyone can call this. The very first account ever created becomes Admin.
// After that, anyone registering without being logged in as an Admin becomes a
// Note-taker (the safe default) - only an already-logged-in Admin can hand out
// the Admin or Media role to someone else.
router.post('/register', (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!email || !email.includes('@')) return res.status(400).json({ ok: false, error: 'Please enter a valid email address.' });
    if (password.length < 8) return res.status(400).json({ ok: false, error: 'Password must be at least 8 characters.' });

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) return res.status(409).json({ ok: false, error: 'An account with that email already exists.' });

    const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    let role = 'notetaker';
    if (userCount === 0) role = 'admin';

    const caller = currentUser(req);
    const callerIsAdmin = caller && caller.role === 'admin' && userCount > 0;
    if (callerIsAdmin && ROLES.includes(req.body.role)) role = req.body.role;

    const hash = bcrypt.hashSync(password, 10);
    const info = db.prepare('INSERT INTO users (email, password_hash, role) VALUES (?, ?, ?)').run(email, hash, role);
    const user = { id: Number(info.lastInsertRowid), email, role };
    // Only log the browser into the NEW account when this was genuine self-registration.
    // An Admin creating a teammate's account must stay logged in as themselves.
    if (!callerIsAdmin) signCookie(res, user);
    res.json({ ok: true, user });
});

router.post('/login', (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const row = db.prepare('SELECT id, email, password_hash, role FROM users WHERE email = ?').get(email);
    if (!row || !bcrypt.compareSync(password, row.password_hash)) {
        return res.status(401).json({ ok: false, error: 'Wrong email or password.' });
    }
    const user = { id: row.id, email: row.email, role: row.role };
    signCookie(res, user);
    res.json({ ok: true, user });
});

router.post('/logout', (req, res) => {
    const token = req.cookies[COOKIE_NAME];
    if (token) {
        try { db.prepare('DELETE FROM sessions WHERE id = ?').run(jwt.decode(token).jti); } catch (e) { /* malformed token, nothing to clean up */ }
    }
    res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'lax' });
    res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
    res.json({ ok: true, user: { id: req.user.id, email: req.user.email, role: req.user.role } });
});

module.exports = router;
