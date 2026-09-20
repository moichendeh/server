// The core promise of this change: two people, each with their own account, can never
// see, edit, delete, or download each other's sermons - not even by guessing an id
// or a URL. Every check here proves that from the OUTSIDE (real HTTP requests), the
// same way an attacker would try it.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = 'test-secret-not-for-real-use';
process.env.RATE_LIMIT_DISABLED = '1';
// Its own database - node's test runner can run files in parallel.
process.env.DATABASE_URL = process.env.DATABASE_URL_TEST_ISOLATION || 'postgresql://postgres:postgres@localhost:5432/sermon_scribe_test_isolation';
process.env.ADMIN_EMAILS = 'nobody-is-admin-in-this-file@example.com';

const db = require('../db');
const app = require('../server');

let server, base;
function cookieFrom(res) { return (res.headers.get('set-cookie') || '').split(';')[0]; }
async function call(method, url, { body, cookie } = {}) {
    const res = await fetch(base + url, {
        method,
        headers: { 'Content-Type': 'application/json', Origin: base, ...(cookie ? { Cookie: cookie } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, json, cookie: cookieFrom(res) };
}
async function newUser(email) {
    const r = await call('POST', '/api/auth/register', { body: { name: 'Test', email, password: 'correcthorsebattery', privacyAccepted: true } });
    assert.equal(r.status, 200, 'setup: registration must succeed');
    return r.cookie;
}

let cookieA, cookieB, sermonAId, otherSermonId;

// One before() hook - everything here must finish, in order, before any test runs.
test.before(async () => {
    await db.ready;
    await db.exec('DROP TABLE IF EXISTS scripture_mentions, paragraphs, sessions, login_events, sermons, bible_cache, settings, screen_codes, users CASCADE');
    await db.exec(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'db', 'migrate.sql'), 'utf8'));
    await db.exec(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
    server = app.listen(0);
    await new Promise(r => server.once('listening', r));
    base = 'http://127.0.0.1:' + server.address().port;

    cookieA = await newUser('usera@example.com');
    cookieB = await newUser('userb@example.com');
    const created = await call('POST', '/api/sermons', { cookie: cookieA, body: { title: "A's private sermon", date: '2026-09-20' } });
    sermonAId = created.json.sermon.id;
    await call('PATCH', '/api/sermons/' + sermonAId, {
        cookie: cookieA,
        body: {
            baseUpdatedAt: created.json.sermon.updatedAt,
            paragraphs: [{ t: 0, lang: 'en', text: 'Secret notes only A should see', refs: [{ bookNr: 1, chapter: 1, from: 1, to: 1 }] }]
        }
    });
    // A second sermon belonging to A, purely so B has more than one id to try guessing.
    const created2 = await call('POST', '/api/sermons', { cookie: cookieA, body: { title: "A's other sermon", date: '2026-09-21' } });
    otherSermonId = created2.json.sermon.id;
});
test.after(async () => {
    await new Promise(r => server.close(r));
    await db.close();
});

test('B cannot LIST A\'s sermons - the list endpoint only ever returns your own', async () => {
    const listA = await call('GET', '/api/sermons', { cookie: cookieA });
    const listB = await call('GET', '/api/sermons', { cookie: cookieB });
    assert.ok(listA.json.sermons.some(s => s.id === sermonAId));
    assert.equal(listB.json.sermons.length, 0);
});

test('B cannot OPEN A\'s sermon by guessing its id - 404, not the content', async () => {
    const r = await call('GET', '/api/sermons/' + sermonAId, { cookie: cookieB });
    assert.equal(r.status, 404);
    assert.equal(JSON.stringify(r.json).includes('Secret notes'), false);
});

test('B cannot EDIT A\'s sermon by guessing its id', async () => {
    const r = await call('PATCH', '/api/sermons/' + sermonAId, {
        cookie: cookieB,
        body: { title: 'Hacked by B', baseUpdatedAt: null }
    });
    assert.equal(r.status, 404);
    const stillA = await call('GET', '/api/sermons/' + sermonAId, { cookie: cookieA });
    assert.notEqual(stillA.json.sermon.title, 'Hacked by B');
});

test('B cannot DELETE A\'s sermon by guessing its id, and it still exists for A afterward', async () => {
    const r = await call('DELETE', '/api/sermons/' + sermonAId, { cookie: cookieB });
    assert.equal(r.status, 404);
    const stillThere = await call('GET', '/api/sermons/' + sermonAId, { cookie: cookieA });
    assert.equal(stillThere.status, 200);
});

test('B cannot "download" (read the data an export/print would use) A\'s sermon either', async () => {
    // Word/text export happens client-side from the same GET the app uses to open a
    // sermon - if that is blocked (already proven above), so is every export built on
    // top of it. Confirm the dedicated "download my data" export is also scoped.
    const r = await call('GET', '/api/me/export', { cookie: cookieB });
    assert.equal(r.status, 200);
    assert.equal(r.json.sermons.some(s => s.id === sermonAId), false, "B's own export must not include A's sermon id");
    assert.equal(JSON.stringify(r.json).includes('Secret notes only A should see'), false, "B's own export must not contain A's sermon text");
});

test('trying every guessable nearby id finds nothing belonging to B', async () => {
    for (const id of [sermonAId - 1, sermonAId, sermonAId + 1, otherSermonId, otherSermonId + 1, 999999]) {
        const r = await call('GET', '/api/sermons/' + id, { cookie: cookieB });
        assert.ok(r.status === 404, `id ${id} should be 404 for B, got ${r.status}`);
    }
});

test('a non-numeric or negative id is rejected the same way, not passed to the database', async () => {
    for (const bad of ['abc', '-1', '1;DROP TABLE sermons', '1.5']) {
        const r = await call('GET', '/api/sermons/' + encodeURIComponent(bad), { cookie: cookieA });
        assert.equal(r.status, 404);
    }
    // Prove the table really is still there and usable.
    const still = await call('GET', '/api/sermons', { cookie: cookieA });
    assert.equal(still.status, 200);
});

test('settings are isolated too - B changing their settings never touches A\'s', async () => {
    await call('PATCH', '/api/settings', { cookie: cookieB, body: { projMode: 'voice' } });
    const aSettings = await call('GET', '/api/settings', { cookie: cookieA });
    assert.equal(aSettings.json.settings.projMode, 'ask', "A's settings must be unaffected by B's change");
});

test('B has their own, different screen code from A', async () => {
    const codeA = await call('GET', '/api/screen-code', { cookie: cookieA });
    const codeB = await call('GET', '/api/screen-code', { cookie: cookieB });
    assert.notEqual(codeA.json.code, codeB.json.code);
});
