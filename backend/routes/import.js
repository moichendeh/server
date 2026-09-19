const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// Takes the old browser-only save file shape ({sermons:[...], ...settings}) and copies
// each sermon into the database as a new sermon, so nothing typed before this app had a
// server is lost. Skips a sermon if one with the exact same title and date already exists,
// so clicking the button twice by accident doesn't duplicate everything.
router.post('/', requireAuth, requireRole('admin', 'notetaker'), (req, res) => {
    const sermons = Array.isArray(req.body.sermons) ? req.body.sermons : [];
    let imported = 0, skipped = 0;

    const findExisting = db.prepare('SELECT id FROM sermons WHERE title = ? AND date = ?');
    const insertSermon = db.prepare('INSERT INTO sermons (title, date, elapsed, created_by) VALUES (?, ?, ?, ?)');
    const insertPara = db.prepare('INSERT INTO paragraphs (sermon_id, seq, t, lang, speaker, text) VALUES (?, ?, ?, ?, ?, ?)');
    const insertMention = db.prepare(
        'INSERT INTO scripture_mentions (sermon_id, paragraph_id, book_nr, chapter, from_verse, to_verse, whole, check_flag, follow_up, mention_count, at_seconds) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );

    try {
        db.exec('BEGIN');
        for (const s of sermons) {
            const title = String(s.title || '');
            const date = String(s.date || '');
            if (findExisting.get(title, date)) { skipped++; continue; }

            const info = insertSermon.run(title, date, Number(s.elapsed) || 0, req.user.id);
            const sermonId = Number(info.lastInsertRowid);
            (s.paras || []).forEach((p, idx) => {
                const pInfo = insertPara.run(sermonId, idx, Number(p.t) || 0, String(p.lang || 'en'), null, String(p.text || ''));
                const paraId = Number(pInfo.lastInsertRowid);
                (p.refs || []).forEach(r => {
                    insertMention.run(
                        sermonId, paraId, Number(r.bookNr), Number(r.chapter),
                        r.from == null ? null : Number(r.from), r.to == null ? null : Number(r.to),
                        0, 0, 0, 1, Number(p.t) || 0
                    );
                });
            });
            imported++;
        }
        db.exec('COMMIT');
    } catch (e) {
        db.exec('ROLLBACK');
        throw e;
    }

    res.json({ ok: true, imported, skipped });
});

module.exports = router;
