const express = require('express');
const db = require('../db');
const asyncHandler = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

const SORT_COLUMNS = {
    name: 'u.name', email: 'u.email', createdAt: 'u.created_at',
    lastLoginAt: 'u.last_login_at', loginCount: 'u.login_count', sermonCount: 'sermon_count'
};

// The user list never includes sermon TEXT, only a count - admins can see who is
// using the app and moderate accounts, never read anyone's sermons.
router.get('/users', asyncHandler(async (req, res) => {
    const search = String(req.query.search || '').trim();
    const sortCol = SORT_COLUMNS[req.query.sort] || 'u.created_at';
    const dir = req.query.dir === 'asc' ? 'ASC' : 'DESC';

    const rows = await db.prepare(`
        SELECT u.id, u.name, u.email, u.role, u.is_disabled AS "isDisabled",
               u.created_at AS "createdAt", u.last_login_at AS "lastLoginAt", u.login_count AS "loginCount",
               COUNT(s.id) AS "sermonCount"
        FROM users u
        LEFT JOIN sermons s ON s.user_id = u.id
        WHERE u.name ILIKE ? OR u.email ILIKE ?
        GROUP BY u.id
        ORDER BY ${sortCol} ${dir}
    `).all('%' + search + '%', '%' + search + '%');

    res.json({ ok: true, users: rows.map(r => ({ ...r, sermonCount: Number(r.sermonCount) })) });
}));

router.post('/users/:id/disable', asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (id === req.user.id) return res.status(400).json({ ok: false, error: 'You cannot disable your own account here.' });
    const info = await db.prepare('UPDATE users SET is_disabled = true WHERE id = ?').run(id);
    if (info.changes === 0) return res.status(404).json({ ok: false, error: 'User not found.' });
    await db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id); // end any of their active logins immediately
    res.json({ ok: true });
}));

router.post('/users/:id/enable', asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const info = await db.prepare('UPDATE users SET is_disabled = false WHERE id = ?').run(id);
    if (info.changes === 0) return res.status(404).json({ ok: false, error: 'User not found.' });
    res.json({ ok: true });
}));

router.delete('/users/:id', asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (id === req.user.id) return res.status(400).json({ ok: false, error: 'Use "Delete my account" in your own settings instead.' });
    await db.transaction(async tx => {
        await tx.prepare('DELETE FROM sermons WHERE user_id = ?').run(id); // cascades to paragraphs + mentions
        await tx.prepare('DELETE FROM users WHERE id = ?').run(id); // cascades sessions, login_events, settings, screen_codes
    });
    res.json({ ok: true });
}));

module.exports = router;
