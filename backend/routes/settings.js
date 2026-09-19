const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

const DEFAULTS = {
    lang: 'en',
    accent: { en: 'en-GH', de: 'de-CH' },
    tr: 'kjv',
    projMode: 'ask',
    triggerPhrases: ['project', 'project it', 'put it on the screen', 'show it', 'media', 'projizieren', 'bitte einblenden', 'auf den bildschirm'],
    projLayout: 'en',
    projTrEn: 'kjv',
    projTrDe: 'elb1905'
};

function readSettings() {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const out = { ...DEFAULTS };
    rows.forEach(r => { try { out[r.key] = JSON.parse(r.value); } catch (e) { /* ignore a corrupt row */ } });
    return out;
}

router.get('/', requireAuth, (req, res) => {
    res.json({ ok: true, settings: readSettings() });
});

router.patch('/', requireAuth, requireRole('admin', 'notetaker'), (req, res) => {
    const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    Object.keys(DEFAULTS).forEach(key => {
        if (req.body[key] !== undefined) upsert.run(key, JSON.stringify(req.body[key]));
    });
    res.json({ ok: true, settings: readSettings() });
});

module.exports = router;
