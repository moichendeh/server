const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const asyncHandler = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireRole('admin', 'notetaker'));

function generateCode() { return crypto.randomBytes(8).toString('base64url'); }

// Stored in the same key/value settings table as everything else - there is only ever
// one valid code at a time, which is exactly what makes "create a new one" revoke the
// old link.
async function readCode() {
    const row = await db.prepare('SELECT value FROM settings WHERE key = ?').get('screenCode');
    return row ? JSON.parse(row.value) : null;
}
async function writeCode(code) {
    await db.prepare("INSERT INTO settings (key, value) VALUES ('screenCode', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(code));
}

router.get('/', asyncHandler(async (req, res) => {
    let code = await readCode();
    if (!code) { code = generateCode(); await writeCode(code); }
    res.json({ ok: true, code });
}));

router.post('/', asyncHandler(async (req, res) => {
    const code = generateCode();
    await writeCode(code);
    res.json({ ok: true, code });
}));

module.exports = router;
module.exports.getCurrentCode = readCode;
