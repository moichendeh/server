const express = require('express');
const db = require('../db');
const asyncHandler = require('../middleware/asyncHandler');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Takes the old browser-only save file shape ({sermons:[...], ...settings}) and copies
// each sermon into the LOGGED-IN USER'S OWN account, so nothing typed before this app
// had a server is lost. Skips a sermon if that same user already has one with the
// exact same title and date, so clicking the button twice by accident doesn't
// duplicate everything (checked per-user, not against everyone else's sermons).
router.post('/', requireAuth, asyncHandler(async (req, res) => {
    const sermons = Array.isArray(req.body.sermons) ? req.body.sermons : [];
    let imported = 0, skipped = 0;

    await db.transaction(async tx => {
        const findExisting = tx.prepare('SELECT id FROM sermons WHERE title = ? AND date = ? AND user_id = ?');
        const insertSermon = tx.prepare('INSERT INTO sermons (title, date, elapsed, user_id) VALUES (?, ?, ?, ?) RETURNING id');
        const insertPara = tx.prepare('INSERT INTO paragraphs (sermon_id, user_id, seq, t, lang, speaker, text) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id');
        const insertMention = tx.prepare(
            'INSERT INTO scripture_mentions (sermon_id, user_id, paragraph_id, book_nr, chapter, from_verse, to_verse, whole, check_flag, follow_up, mention_count, at_seconds) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        );

        for (const s of sermons) {
            const title = String(s.title || '').slice(0, 300);
            const date = String(s.date || '').slice(0, 20);
            if (await findExisting.get(title, date, req.user.id)) { skipped++; continue; }

            const info = await insertSermon.run(title, date, Number(s.elapsed) || 0, req.user.id);
            const sermonId = Number(info.lastInsertRowid);
            const paras = s.paras || [];
            for (let idx = 0; idx < paras.length; idx++) {
                const p = paras[idx];
                const pInfo = await insertPara.run(sermonId, req.user.id, idx, Number(p.t) || 0, String(p.lang || 'en').slice(0, 20), null, String(p.text || '').slice(0, 10000));
                const paraId = Number(pInfo.lastInsertRowid);
                for (const r of (p.refs || [])) {
                    await insertMention.run(
                        sermonId, req.user.id, paraId, Number(r.bookNr), Number(r.chapter),
                        r.from == null ? null : Number(r.from), r.to == null ? null : Number(r.to),
                        0, 0, 0, 1, Number(p.t) || 0
                    );
                }
            }
            imported++;
        }
    });

    res.json({ ok: true, imported, skipped });
}));

module.exports = router;
