const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireRole('admin', 'notetaker'));

function getSermonDetail(id) {
    const sermon = db.prepare('SELECT * FROM sermons WHERE id = ?').get(id);
    if (!sermon) return null;
    const paraRows = db.prepare('SELECT * FROM paragraphs WHERE sermon_id = ? ORDER BY seq').all(id);
    const mentionRows = db.prepare('SELECT * FROM scripture_mentions WHERE sermon_id = ? ORDER BY id').all(id);

    const paragraphs = paraRows.map(p => ({
        id: p.id,
        t: p.t,
        lang: p.lang,
        speaker: p.speaker,
        text: p.text,
        refs: mentionRows
            .filter(m => m.paragraph_id === p.id)
            .map(m => ({ bookNr: m.book_nr, chapter: m.chapter, from: m.from_verse, to: m.to_verse }))
    }));

    const groups = new Map();
    mentionRows.forEach(m => {
        const key = m.book_nr + ':' + m.chapter + ':' + (m.from_verse ?? '') + '-' + (m.to_verse ?? '');
        if (!groups.has(key)) {
            groups.set(key, { key, bookNr: m.book_nr, chapter: m.chapter, from: m.from_verse, to: m.to_verse, count: 0, at: m.at_seconds });
        }
        const g = groups.get(key);
        g.count += m.mention_count;
        g.at = Math.min(g.at, m.at_seconds);
    });

    return {
        id: sermon.id, title: sermon.title, date: sermon.date, elapsed: sermon.elapsed,
        updatedAt: sermon.updated_at,
        paragraphs, mentions: [...groups.values()]
    };
}

router.get('/', (req, res) => {
    const rows = db.prepare('SELECT id, title, date, elapsed, updated_at AS updatedAt FROM sermons ORDER BY date DESC, id DESC').all();
    res.json({ ok: true, sermons: rows });
});

router.post('/', (req, res) => {
    const title = req.body.title !== undefined ? String(req.body.title) : '';
    const date = req.body.date !== undefined ? String(req.body.date) : new Date().toISOString().slice(0, 10);
    const info = db.prepare('INSERT INTO sermons (title, date, elapsed, created_by) VALUES (?, ?, 0, ?)').run(title, date, req.user.id);
    res.json({ ok: true, sermon: getSermonDetail(Number(info.lastInsertRowid)) });
});

router.get('/:id', (req, res) => {
    const detail = getSermonDetail(Number(req.params.id));
    if (!detail) return res.status(404).json({ ok: false, error: 'Sermon not found.' });
    res.json({ ok: true, sermon: detail });
});

router.patch('/:id', (req, res) => {
    const id = Number(req.params.id);
    const cur = db.prepare('SELECT * FROM sermons WHERE id = ?').get(id);
    if (!cur) return res.status(404).json({ ok: false, error: 'Sermon not found.' });

    if (req.body.baseUpdatedAt !== undefined && req.body.baseUpdatedAt !== cur.updated_at) {
        return res.status(409).json({ ok: false, error: 'conflict', updatedAt: cur.updated_at });
    }

    const title = req.body.title !== undefined ? String(req.body.title) : cur.title;
    const date = req.body.date !== undefined ? String(req.body.date) : cur.date;
    const elapsed = req.body.elapsed !== undefined ? (Number(req.body.elapsed) || 0) : cur.elapsed;

    try {
        db.exec('BEGIN');
        db.prepare("UPDATE sermons SET title = ?, date = ?, elapsed = ?, updated_at = datetime('now') WHERE id = ?")
            .run(title, date, elapsed, id);

        if (Array.isArray(req.body.paragraphs)) {
            db.prepare('DELETE FROM paragraphs WHERE sermon_id = ?').run(id); // cascades to scripture_mentions
            const insertPara = db.prepare('INSERT INTO paragraphs (sermon_id, seq, t, lang, speaker, text) VALUES (?, ?, ?, ?, ?, ?)');
            const insertMention = db.prepare(
                'INSERT INTO scripture_mentions (sermon_id, paragraph_id, book_nr, chapter, from_verse, to_verse, whole, check_flag, follow_up, mention_count, at_seconds) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
            );
            req.body.paragraphs.forEach((p, idx) => {
                const info = insertPara.run(id, idx, Number(p.t) || 0, String(p.lang || 'en'), p.speaker ? String(p.speaker) : null, String(p.text || ''));
                const paraId = Number(info.lastInsertRowid);
                (p.refs || []).forEach(r => {
                    insertMention.run(
                        id, paraId, Number(r.bookNr), Number(r.chapter),
                        r.from == null ? null : Number(r.from), r.to == null ? null : Number(r.to),
                        r.whole ? 1 : 0, r.check ? 1 : 0, r.followUp ? 1 : 0, 1, Number(p.t) || 0
                    );
                });
            });
        }
        db.exec('COMMIT');
    } catch (e) {
        db.exec('ROLLBACK');
        throw e;
    }

    res.json({ ok: true, sermon: getSermonDetail(id) });
});

router.delete('/:id', (req, res) => {
    const id = Number(req.params.id);
    const info = db.prepare('DELETE FROM sermons WHERE id = ?').run(id); // cascades to paragraphs + mentions
    if (info.changes === 0) return res.status(404).json({ ok: false, error: 'Sermon not found.' });
    res.json({ ok: true });
});

module.exports = router;
