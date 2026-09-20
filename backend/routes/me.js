const express = require('express');
const db = require('../db');
const asyncHandler = require('../middleware/asyncHandler');
const { requireAuth, COOKIE_NAME } = require('../middleware/auth');
const { readSettings } = require('./settings');
const { getSermonDetail } = require('./sermons');

const router = express.Router();
router.use(requireAuth);

// Everything this one person has ever put into the app, as one plain JSON file -
// nothing about anyone else, and nothing beyond what is described on the Privacy page.
router.get('/export', asyncHandler(async (req, res) => {
    const user = await db.prepare('SELECT name, email, created_at AS "createdAt" FROM users WHERE id = ?').get(req.user.id);
    const sermonRows = await db.prepare('SELECT id FROM sermons WHERE user_id = ?').all(req.user.id);
    const sermons = [];
    for (const row of sermonRows) sermons.push(await getSermonDetail(db, row.id, req.user.id));
    const settings = await readSettings(req.user.id);

    res.setHeader('Content-Disposition', 'attachment; filename="my-sermon-scribe-data.json"');
    res.json({ ok: true, exportedAt: new Date().toISOString(), user, sermons, settings });
}));

router.delete('/', asyncHandler(async (req, res) => {
    await db.transaction(async tx => {
        await tx.prepare('DELETE FROM sermons WHERE user_id = ?').run(req.user.id); // cascades paragraphs + mentions
        await tx.prepare('DELETE FROM users WHERE id = ?').run(req.user.id); // cascades sessions, login_events, settings, screen_codes
    });
    res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
    res.json({ ok: true });
}));

module.exports = router;
