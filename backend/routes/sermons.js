const express = require('express');
const db = require('../db');
const asyncHandler = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireRole('admin', 'notetaker'));

async function getSermonDetail(dbOrTx, id) {
    const sermon = await dbOrTx.prepare('SELECT * FROM sermons WHERE id = ?').get(id);
    if (!sermon) return null;
    const paraRows = await dbOrTx.prepare('SELECT * FROM paragraphs WHERE sermon_id = ? ORDER BY seq').all(id);
    const mentionRows = await dbOrTx.prepare('SELECT * FROM scripture_mentions WHERE sermon_id = ? ORDER BY id').all(id);

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

router.get('/', asyncHandler(async (req, res) => {
    const rows = await db.prepare('SELECT id, title, date, elapsed, updated_at AS "updatedAt" FROM sermons ORDER BY date DESC, id DESC').all();
    res.json({ ok: true, sermons: rows });
}));

router.post('/', asyncHandler(async (req, res) => {
    const title = req.body.title !== undefined ? String(req.body.title) : '';
    const date = req.body.date !== undefined ? String(req.body.date) : new Date().toISOString().slice(0, 10);
    const info = await db.prepare('INSERT INTO sermons (title, date, elapsed, created_by) VALUES (?, ?, 0, ?) RETURNING id').run(title, date, req.user.id);
    res.json({ ok: true, sermon: await getSermonDetail(db, Number(info.lastInsertRowid)) });
}));

router.get('/:id', asyncHandler(async (req, res) => {
    const detail = await getSermonDetail(db, Number(req.params.id));
    if (!detail) return res.status(404).json({ ok: false, error: 'Sermon not found.' });
    res.json({ ok: true, sermon: detail });
}));

router.patch('/:id', asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const cur = await db.prepare('SELECT * FROM sermons WHERE id = ?').get(id);
    if (!cur) return res.status(404).json({ ok: false, error: 'Sermon not found.' });

    if (req.body.baseUpdatedAt !== undefined && req.body.baseUpdatedAt !== cur.updated_at) {
        return res.status(409).json({ ok: false, error: 'conflict', updatedAt: cur.updated_at });
    }

    const title = req.body.title !== undefined ? String(req.body.title) : cur.title;
    const date = req.body.date !== undefined ? String(req.body.date) : cur.date;
    const elapsed = req.body.elapsed !== undefined ? (Number(req.body.elapsed) || 0) : cur.elapsed;

    await db.transaction(async tx => {
        await tx.prepare("UPDATE sermons SET title = ?, date = ?, elapsed = ?, updated_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?")
            .run(title, date, elapsed, id);

        if (Array.isArray(req.body.paragraphs)) {
            await tx.prepare('DELETE FROM paragraphs WHERE sermon_id = ?').run(id); // cascades to scripture_mentions
            const insertPara = tx.prepare('INSERT INTO paragraphs (sermon_id, seq, t, lang, speaker, text) VALUES (?, ?, ?, ?, ?, ?) RETURNING id');
            const insertMention = tx.prepare(
                'INSERT INTO scripture_mentions (sermon_id, paragraph_id, book_nr, chapter, from_verse, to_verse, whole, check_flag, follow_up, mention_count, at_seconds) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
            );
            for (let idx = 0; idx < req.body.paragraphs.length; idx++) {
                const p = req.body.paragraphs[idx];
                const info = await insertPara.run(id, idx, Number(p.t) || 0, String(p.lang || 'en'), p.speaker ? String(p.speaker) : null, String(p.text || ''));
                const paraId = Number(info.lastInsertRowid);
                for (const r of (p.refs || [])) {
                    await insertMention.run(
                        id, paraId, Number(r.bookNr), Number(r.chapter),
                        r.from == null ? null : Number(r.from), r.to == null ? null : Number(r.to),
                        r.whole ? 1 : 0, r.check ? 1 : 0, r.followUp ? 1 : 0, 1, Number(p.t) || 0
                    );
                }
            }
        }
    });

    res.json({ ok: true, sermon: await getSermonDetail(db, id) });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const info = await db.prepare('DELETE FROM sermons WHERE id = ?').run(id); // cascades to paragraphs + mentions
    if (info.changes === 0) return res.status(404).json({ ok: false, error: 'Sermon not found.' });
    res.json({ ok: true });
}));

module.exports = router;
