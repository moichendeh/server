const express = require('express');
const db = require('../db');
const asyncHandler = require('../middleware/asyncHandler');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const API_BASE = 'https://api.scripture.api.bible/v1';

// api.bible identifies a translation by an opaque "bibleId" (a GUID) rather than a
// short code like "niv" - and which GUID that is can differ per api.bible account,
// depending on which translations that account has been granted. So instead of
// hardcoding a GUID we might get wrong, we ask api.bible for this account's own list
// of Bibles once and match by abbreviation - cached in memory after the first lookup.
const WANTED = { niv: 'NIV', amp: 'AMP', csb: 'CSB' };
let bibleIdCache = null; // trKey -> bibleId

// Standard USFM book codes for the 66 Protestant canon books, in the same order as
// the frontend's BOOKS list (Genesis first, Revelation last) - api.bible addresses a
// chapter as "<CODE>.<chapter>" (e.g. "JHN.3"), not by book number.
const USFM_CODES = [
    'GEN', 'EXO', 'LEV', 'NUM', 'DEU', 'JOS', 'JDG', 'RUT', '1SA', '2SA', '1KI', '2KI', '1CH', '2CH',
    'EZR', 'NEH', 'EST', 'JOB', 'PSA', 'PRO', 'ECC', 'SNG', 'ISA', 'JER', 'LAM', 'EZK', 'DAN', 'HOS',
    'JOL', 'AMO', 'OBA', 'JON', 'MIC', 'NAM', 'HAB', 'ZEP', 'HAG', 'ZEC', 'MAL',
    'MAT', 'MRK', 'LUK', 'JHN', 'ACT', 'ROM', '1CO', '2CO', 'GAL', 'EPH', 'PHP', 'COL', '1TH', '2TH',
    '1TI', '2TI', 'TIT', 'PHM', 'HEB', 'JAS', '1PE', '2PE', '1JN', '2JN', '3JN', 'JUD', 'REV'
];

async function apiBibleFetch(path, params) {
    const url = new URL(API_BASE + path);
    Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, v));
    const r = await fetch(url, { headers: { 'api-key': process.env.API_BIBLE_KEY } });
    if (!r.ok) throw new Error('api.bible request failed (HTTP ' + r.status + ')');
    const j = await r.json();
    return j.data;
}

async function resolveBibleIds() {
    if (bibleIdCache) return bibleIdCache;
    const bibles = await apiBibleFetch('/bibles', { language: 'eng' });
    const map = {};
    for (const [trKey, abbrev] of Object.entries(WANTED)) {
        const match = (bibles || []).find(b => (b.abbreviationLocal || b.abbreviation || '').toUpperCase() === abbrev);
        if (match) map[trKey] = match.id;
    }
    bibleIdCache = map;
    return map;
}

// api.bible's json content is a tree of paragraph/verse nodes (USX-style). Walk it in
// document order, treating each "verse" tag as a start/end milestone and collecting
// the "text" nodes found in between into that verse's buffer.
function parseVerses(nodes) {
    const verses = [];
    let current = null;
    function walk(items) {
        for (const item of items || []) {
            if (item.type === 'tag' && item.name === 'verse') {
                const attrs = item.attrs || {};
                if (attrs.number !== undefined) {
                    current = { v: +attrs.number, t: '' };
                    verses.push(current);
                } else if (attrs.eid !== undefined) {
                    current = null;
                }
            } else if (item.type === 'text') {
                if (current) current.t += item.text;
            } else if (item.items) {
                walk(item.items);
            }
        }
    }
    walk(nodes);
    verses.forEach(v => { v.t = v.t.replace(/\s+/g, ' ').trim(); });
    return verses.filter(v => v.t);
}

// Bible text is the same for everyone regardless of who looked it up first, and
// api.bible accounts have a request quota - so a chapter is fetched from api.bible at
// most once per translation, ever, and served from bible_cache after that.
router.get('/:trKey/:bookNr/:chapter', requireAuth, asyncHandler(async (req, res) => {
    const trKey = req.params.trKey;
    if (!WANTED[trKey]) return res.status(404).json({ ok: false, error: 'Unknown translation.' });
    const bookNr = +req.params.bookNr;
    const chapter = +req.params.chapter;
    if (!Number.isInteger(bookNr) || bookNr < 1 || bookNr > 66 || !Number.isInteger(chapter) || chapter < 1) {
        return res.status(400).json({ ok: false, error: 'Invalid book or chapter.' });
    }

    const cached = await db.prepare(
        'SELECT verses_json FROM bible_cache WHERE translation = ? AND book_nr = ? AND chapter = ?'
    ).get(trKey, bookNr, chapter);
    if (cached) return res.json({ ok: true, verses: JSON.parse(cached.verses_json) });

    if (!process.env.API_BIBLE_KEY) {
        return res.status(503).json({ ok: false, error: 'API.Bible is not configured on this server.' });
    }

    let verses;
    try {
        const ids = await resolveBibleIds();
        const bibleId = ids[trKey];
        if (!bibleId) {
            return res.status(503).json({ ok: false, error: 'This translation is not available on this server’s api.bible account.' });
        }
        const chapterId = USFM_CODES[bookNr - 1] + '.' + chapter;
        const data = await apiBibleFetch('/bibles/' + bibleId + '/chapters/' + chapterId, {
            'content-type': 'json',
            'include-notes': 'false',
            'include-titles': 'false',
            'include-chapter-numbers': 'false',
            'include-verse-numbers': 'true'
        });
        verses = parseVerses(data.content);
    } catch (e) {
        return res.status(502).json({ ok: false, error: 'Could not reach api.bible.' });
    }

    await db.prepare(
        `INSERT INTO bible_cache (translation, book_nr, chapter, verses_json) VALUES (?, ?, ?, ?)
         ON CONFLICT (translation, book_nr, chapter)
         DO UPDATE SET verses_json = excluded.verses_json, fetched_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS')`
    ).run(trKey, bookNr, chapter, JSON.stringify(verses));

    res.json({ ok: true, verses });
}));

module.exports = router;
