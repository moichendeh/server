const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const asyncHandler = require('../middleware/asyncHandler');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

function generateCode() { return crypto.randomBytes(8).toString('base64url'); }

async function readCode(userId) {
    const row = await db.prepare('SELECT code FROM screen_codes WHERE user_id = ?').get(userId);
    return row ? row.code : null;
}
async function writeCode(userId, code) {
    await db.prepare(
        'INSERT INTO screen_codes (user_id, code) VALUES (?, ?) ON CONFLICT (user_id) DO UPDATE SET code = excluded.code, created_at = excluded.created_at'
    ).run(userId, code);
}
// Which user (if any) a screen code belongs to - used by live.js to route a code-only
// projector connection into that one user's room, and nobody else's.
async function userIdForCode(code) {
    const row = await db.prepare('SELECT user_id FROM screen_codes WHERE code = ?').get(code);
    return row ? row.user_id : null;
}

router.get('/', asyncHandler(async (req, res) => {
    let code = await readCode(req.user.id);
    if (!code) { code = generateCode(); await writeCode(req.user.id, code); }
    res.json({ ok: true, code });
}));

router.post('/', asyncHandler(async (req, res) => {
    const code = generateCode();
    await writeCode(req.user.id, code);
    res.json({ ok: true, code });
}));

module.exports = router;
module.exports.userIdForCode = userIdForCode;
