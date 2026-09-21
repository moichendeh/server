const express = require('express');
const db = require('../db');
const asyncHandler = require('../middleware/asyncHandler');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const DEFAULTS = {
    lang: 'en',
    accent: { en: 'en-GH', de: 'de-CH' },
    tr: 'kjv',
    projMode: 'ask',
    triggerPhrases: ['project', 'project it', 'put it on the screen', 'show it', 'media', 'projizieren', 'bitte einblenden', 'auf den bildschirm'],
    projLayout: 'en',
    projTrEn: 'kjv',
    projTrDe: 'elb1905',
    // Opt-in, not opt-out - sermon text is only ever sent to the AI provider once a
    // user has explicitly agreed to that in their own settings (see the privacy page).
    aiEnabled: false,
    translateTo: 'none'
};

async function readSettings(userId) {
    const rows = await db.prepare('SELECT key, value FROM settings WHERE user_id = ?').all(userId);
    const out = { ...DEFAULTS };
    rows.forEach(r => { try { out[r.key] = JSON.parse(r.value); } catch (e) { /* ignore a corrupt row */ } });
    return out;
}

router.get('/', requireAuth, asyncHandler(async (req, res) => {
    res.json({ ok: true, settings: await readSettings(req.user.id) });
}));

router.patch('/', requireAuth, asyncHandler(async (req, res) => {
    const upsert = db.prepare('INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value');
    for (const key of Object.keys(DEFAULTS)) {
        if (req.body[key] !== undefined) await upsert.run(req.user.id, key, JSON.stringify(req.body[key]));
    }
    res.json({ ok: true, settings: await readSettings(req.user.id) });
}));

module.exports = router;
module.exports.readSettings = readSettings;
