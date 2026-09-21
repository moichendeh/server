const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = 'test-secret-not-for-real-use';
process.env.RATE_LIMIT_DISABLED = '1';
process.env.DATABASE_URL = process.env.DATABASE_URL_TEST_BIBLE || 'postgresql://postgres:postgres@localhost:5432/sermon_scribe_test_bible';
process.env.ADMIN_EMAILS = '';
process.env.API_BIBLE_KEY = 'test-key';

const db = require('../db');
const app = require('../server');

// No real api.bible account/key in this test environment - stand in for it with a
// fake catalog (AMP missing on purpose, to exercise the "not available" path) and a
// single canned chapter response, and let every other fetch (the test's own calls
// into our local server) through untouched.
const realFetch = global.fetch;
let chapterCalls = 0;
global.fetch = async (url, opts) => {
    const s = String(url);
    if (s.startsWith('https://api.scripture.api.bible/v1/bibles?')) {
        return {
            ok: true,
            json: async () => ({ data: [
                { id: 'niv-guid-123', abbreviation: 'NIV' },
                { id: 'csb-guid-456', abbreviationLocal: 'CSB' }
            ] })
        };
    }
    if (s.startsWith('https://api.scripture.api.bible/v1/bibles/niv-guid-123/chapters/JHN.3')) {
        chapterCalls++;
        return {
            ok: true,
            json: async () => ({ data: { content: [
                { type: 'tag', name: 'para', items: [
                    { type: 'tag', name: 'verse', attrs: { number: '16', sid: 'JHN.3.16' } },
                    { type: 'text', text: 'For God so loved the world...' },
                    { type: 'tag', name: 'verse', attrs: { eid: 'JHN.3.16' } }
                ] }
            ] } })
        };
    }
    return realFetch(url, opts);
};

let server, base;
test.before(async () => {
    await db.ready;
    await db.exec('DROP TABLE IF EXISTS scripture_mentions, paragraphs, sessions, login_events, sermons, bible_cache, settings, screen_codes, users CASCADE');
    await db.exec(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'db', 'migrate.sql'), 'utf8'));
    await db.exec(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
    server = app.listen(0);
    await new Promise(r => server.once('listening', r));
    base = 'http://127.0.0.1:' + server.address().port;
});
test.after(async () => {
    await new Promise(r => server.close(r));
    await db.close();
    global.fetch = realFetch;
});

function cookieFrom(res) { return (res.headers.get('set-cookie') || '').split(';')[0]; }
async function call(method, url, { body, cookie } = {}) {
    const res = await realFetch(base + url, {
        method,
        headers: { 'Content-Type': 'application/json', Origin: base, ...(cookie ? { Cookie: cookie } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, json, cookie: cookieFrom(res) };
}
async function registerAndLogin(email) {
    return call('POST', '/api/auth/register', { body: { name: 'T', email, password: 'correcthorsebattery', privacyAccepted: true } });
}

test('an unauthenticated request is rejected', async () => {
    const r = await call('GET', '/api/bible/niv/43/3');
    assert.equal(r.status, 401);
});

test('an unknown translation key is rejected', async () => {
    const u = await registerAndLogin('bible1@example.com');
    const r = await call('GET', '/api/bible/nope/43/3', { cookie: u.cookie });
    assert.equal(r.status, 404);
});

test('an invalid book or chapter number is rejected', async () => {
    const u = await registerAndLogin('bible2@example.com');
    const r = await call('GET', '/api/bible/niv/999/3', { cookie: u.cookie });
    assert.equal(r.status, 400);
});

test('fetches and parses a chapter from api.bible, then serves it from bible_cache on repeat', async () => {
    const u = await registerAndLogin('bible3@example.com');
    const r = await call('GET', '/api/bible/niv/43/3', { cookie: u.cookie });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.verses, [{ v: 16, t: 'For God so loved the world...' }]);
    assert.equal(chapterCalls, 1);

    const r2 = await call('GET', '/api/bible/niv/43/3', { cookie: u.cookie });
    assert.equal(r2.status, 200);
    assert.deepEqual(r2.json.verses, [{ v: 16, t: 'For God so loved the world...' }]);
    assert.equal(chapterCalls, 1, 'second request should be served from bible_cache, not api.bible again');
});

test('a translation this account has no api.bible access to (AMP) is reported unavailable, not a crash', async () => {
    const u = await registerAndLogin('bible4@example.com');
    const r = await call('GET', '/api/bible/amp/43/3', { cookie: u.cookie });
    assert.equal(r.status, 503);
});
