const express = require('express');
const db = require('../db');
const asyncHandler = require('../middleware/asyncHandler');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Every one of these functions takes the logged-in user's id and filters by it -
// never trusts the :id in the URL alone. A sermon that exists but belongs to someone
// else looks exactly like a sermon that does not exist at all (404), on purpose.
async function getSermonDetail(dbOrTx, id, userId) {
    const sermon = await dbOrTx.prepare('SELECT * FROM sermons WHERE id = ? AND user_id = ?').get(id, userId);
    if (!sermon) return null;
    const paraRows = await dbOrTx.prepare('SELECT * FROM paragraphs WHERE sermon_id = ? AND user_id = ? ORDER BY seq').all(id, userId);
    const mentionRows = await dbOrTx.prepare('SELECT * FROM scripture_mentions WHERE sermon_id = ? AND user_id = ? ORDER BY id').all(id, userId);

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

// :id in the URL is always attacker-controlled input - if it is not even a plain
// number, there is no point asking the database at all.
function parseId(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) { res.status(404).json({ ok: false, error: 'Sermon not found.' }); return null; }
    return id;
}

router.get('/', asyncHandler(async (req, res) => {
    const rows = await db.prepare('SELECT id, title, date, elapsed, updated_at AS "updatedAt" FROM sermons WHERE user_id = ? ORDER BY date DESC, id DESC').all(req.user.id);
    res.json({ ok: true, sermons: rows });
}));

router.post('/', asyncHandler(async (req, res) => {
    const title = req.body.title !== undefined ? String(req.body.title).slice(0, 300) : '';
    const date = req.body.date !== undefined ? String(req.body.date).slice(0, 20) : new Date().toISOString().slice(0, 10);
    const info = await db.prepare('INSERT INTO sermons (title, date, elapsed, user_id) VALUES (?, ?, 0, ?) RETURNING id').run(title, date, req.user.id);
    res.json({ ok: true, sermon: await getSermonDetail(db, Number(info.lastInsertRowid), req.user.id) });
}));

router.get('/:id', asyncHandler(async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    const detail = await getSermonDetail(db, id, req.user.id);
    if (!detail) return res.status(404).json({ ok: false, error: 'Sermon not found.' });
    res.json({ ok: true, sermon: detail });
}));

router.patch('/:id', asyncHandler(async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    const cur = await db.prepare('SELECT * FROM sermons WHERE id = ? AND user_id = ?').get(id, req.user.id);
    if (!cur) return res.status(404).json({ ok: false, error: 'Sermon not found.' });

    if (req.body.baseUpdatedAt !== undefined && req.body.baseUpdatedAt !== cur.updated_at) {
        return res.status(409).json({ ok: false, error: 'conflict', updatedAt: cur.updated_at });
    }

    const title = req.body.title !== undefined ? String(req.body.title).slice(0, 300) : cur.title;
    const date = req.body.date !== undefined ? String(req.body.date).slice(0, 20) : cur.date;
    const elapsed = req.body.elapsed !== undefined ? (Number(req.body.elapsed) || 0) : cur.elapsed;

    await db.transaction(async tx => {
        await tx.prepare("UPDATE sermons SET title = ?, date = ?, elapsed = ?, updated_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS') WHERE id = ? AND user_id = ?")
            .run(title, date, elapsed, id, req.user.id);

        if (Array.isArray(req.body.paragraphs)) {
            await tx.prepare('DELETE FROM paragraphs WHERE sermon_id = ? AND user_id = ?').run(id, req.user.id); // cascades to scripture_mentions
            const insertPara = tx.prepare('INSERT INTO paragraphs (sermon_id, user_id, seq, t, lang, speaker, text) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id');
            const insertMention = tx.prepare(
                'INSERT INTO scripture_mentions (sermon_id, user_id, paragraph_id, book_nr, chapter, from_verse, to_verse, whole, check_flag, follow_up, mention_count, at_seconds) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
            );
            for (let idx = 0; idx < req.body.paragraphs.length; idx++) {
                const p = req.body.paragraphs[idx];
                const info = await insertPara.run(id, req.user.id, idx, Number(p.t) || 0, String(p.lang || 'en').slice(0, 20), p.speaker ? String(p.speaker).slice(0, 100) : null, String(p.text || '').slice(0, 10000));
                const paraId = Number(info.lastInsertRowid);
                for (const r of (p.refs || [])) {
                    await insertMention.run(
                        id, req.user.id, paraId, Number(r.bookNr), Number(r.chapter),
                        r.from == null ? null : Number(r.from), r.to == null ? null : Number(r.to),
                        r.whole ? 1 : 0, r.check ? 1 : 0, r.followUp ? 1 : 0, 1, Number(p.t) || 0
                    );
                }
            }
        }
    });

    res.json({ ok: true, sermon: await getSermonDetail(db, id, req.user.id) });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    const info = await db.prepare('DELETE FROM sermons WHERE id = ? AND user_id = ?').run(id, req.user.id); // cascades to paragraphs + mentions
    if (info.changes === 0) return res.status(404).json({ ok: false, error: 'Sermon not found.' });
    res.json({ ok: true });
}));

module.exports = router;
module.exports.getSermonDetail = getSermonDetail;
