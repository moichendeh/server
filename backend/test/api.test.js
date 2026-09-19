const test = require('node:test');
const assert = require('node:assert/strict');

// A throwaway secret, and a Postgres database dedicated to tests (never your real data).
// DATABASE_URL_TEST lets you point this at a disposable database; falls back to a local
// Postgres with a database named sermon_scribe_test.
process.env.JWT_SECRET = 'test-secret-not-for-real-use';
process.env.DATABASE_URL = process.env.DATABASE_URL_TEST || 'postgresql://postgres:postgres@localhost:5432/sermon_scribe_test';

const db = require('../db');
const app = require('../server');

let server, base;
let adminCookie = '', mediaCookie = '';

test.before(async () => {
    await db.ready;
    // Start every run from a clean slate, regardless of what a previous run left behind.
    await db.exec('DROP TABLE IF EXISTS scripture_mentions, paragraphs, sessions, sermons, bible_cache, settings, users CASCADE');
    await db.exec(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
    server = app.listen(0);
    await new Promise(r => server.once('listening', r));
    base = 'http://127.0.0.1:' + server.address().port;
});
test.after(async () => {
    await new Promise(r => server.close(r));
    await db.close();
});

function cookieFrom(res) {
    const raw = res.headers.get('set-cookie') || '';
    return raw.split(';')[0];
}
async function call(method, url, { body, cookie } = {}) {
    const res = await fetch(base + url, {
        method,
        headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, json, cookie: cookieFrom(res) };
}

test('first registered user becomes admin', async () => {
    const r = await call('POST', '/api/auth/register', { body: { email: 'pastor@example.com', password: 'correcthorsebattery' } });
    assert.equal(r.status, 200);
    assert.equal(r.json.user.role, 'admin');
    adminCookie = r.cookie;
});

test('GET /me reflects the logged-in user', async () => {
    const r = await call('GET', '/api/auth/me', { cookie: adminCookie });
    assert.equal(r.status, 200);
    assert.equal(r.json.user.email, 'pastor@example.com');
});

test('wrong password is rejected', async () => {
    const r = await call('POST', '/api/auth/login', { body: { email: 'pastor@example.com', password: 'nope' } });
    assert.equal(r.status, 401);
});

test('a request with no login at all is rejected', async () => {
    const r = await call('GET', '/api/auth/me');
    assert.equal(r.status, 401);
});

test('a logged-in Admin can create a Media-role user directly, and stays logged in as themselves', async () => {
    const r = await call('POST', '/api/auth/register', { body: { email: 'media@example.com', password: 'correcthorsebattery', role: 'media' }, cookie: adminCookie });
    assert.equal(r.status, 200);
    assert.equal(r.json.user.role, 'media');
    assert.equal(r.cookie, '', 'response must not try to log the browser into the new account');

    const stillAdmin = await call('GET', '/api/auth/me', { cookie: adminCookie });
    assert.equal(stillAdmin.json.user.role, 'admin', 'the admin\'s own cookie must still work and still be admin');

    const login = await call('POST', '/api/auth/login', { body: { email: 'media@example.com', password: 'correcthorsebattery' } });
    mediaCookie = login.cookie;
});

test('public self-registration after the first user defaults to notetaker, never admin', async () => {
    const r = await call('POST', '/api/auth/register', { body: { email: 'someone@example.com', password: 'correcthorsebattery', role: 'admin' } });
    assert.equal(r.status, 200);
    assert.equal(r.json.user.role, 'notetaker'); // requested "admin" is ignored - caller wasn't logged in as one
});

test('duplicate email registration is rejected', async () => {
    const r = await call('POST', '/api/auth/register', { body: { email: 'pastor@example.com', password: 'whatever1' } });
    assert.equal(r.status, 409);
});

test('a Media-role user is forbidden from the sermons API', async () => {
    const r = await call('GET', '/api/sermons', { cookie: mediaCookie });
    assert.equal(r.status, 403);
});

let sermonId, updatedAt;

test('an Admin can create a sermon', async () => {
    const r = await call('POST', '/api/sermons', { body: { title: 'Test Sermon', date: '2026-09-20' }, cookie: adminCookie });
    assert.equal(r.status, 200);
    assert.equal(r.json.sermon.title, 'Test Sermon');
    sermonId = r.json.sermon.id;
    updatedAt = r.json.sermon.updatedAt;
});

test('saving paragraphs stores them and their scripture references', async () => {
    const r = await call('PATCH', '/api/sermons/' + sermonId, {
        cookie: adminCookie,
        body: {
            elapsed: 42, baseUpdatedAt: updatedAt,
            paragraphs: [
                { t: 0, lang: 'en', text: 'Good morning church.', refs: [] },
                { t: 10, lang: 'en', text: 'Turn to John chapter 3 verse 16.', refs: [{ bookNr: 43, chapter: 3, from: 16, to: 16 }] }
            ]
        }
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.sermon.paragraphs.length, 2);
    assert.deepEqual(r.json.sermon.paragraphs[1].refs, [{ bookNr: 43, chapter: 3, from: 16, to: 16 }]);
    assert.equal(r.json.sermon.mentions.length, 1);
    assert.equal(r.json.sermon.mentions[0].count, 1);
    updatedAt = r.json.sermon.updatedAt;
});

test('a fresh GET returns exactly what was saved (this is the real persistence check)', async () => {
    const r = await call('GET', '/api/sermons/' + sermonId, { cookie: adminCookie });
    assert.equal(r.status, 200);
    assert.equal(r.json.sermon.paragraphs[0].text, 'Good morning church.');
    assert.equal(r.json.sermon.elapsed, 42);
});

test('saving with a stale baseUpdatedAt is rejected as a conflict, and does not corrupt the data', async () => {
    const r = await call('PATCH', '/api/sermons/' + sermonId, {
        cookie: adminCookie,
        body: { paragraphs: [{ t: 0, lang: 'en', text: 'A stale writer', refs: [] }], baseUpdatedAt: 'not-the-real-timestamp' }
    });
    assert.equal(r.status, 409);
    const check = await call('GET', '/api/sermons/' + sermonId, { cookie: adminCookie });
    assert.equal(check.json.sermon.paragraphs[0].text, 'Good morning church.');
});

test('settings round-trip: defaults, then a patch persists', async () => {
    const before = await call('GET', '/api/settings', { cookie: adminCookie });
    assert.equal(before.json.settings.projMode, 'ask');
    await call('PATCH', '/api/settings', { cookie: adminCookie, body: { projMode: 'auto' } });
    const after = await call('GET', '/api/settings', { cookie: adminCookie });
    assert.equal(after.json.settings.projMode, 'auto');
});

test('importing old browser sermons adds them, and importing the same ones again is skipped', async () => {
    const payload = { sermons: [{ title: 'Old Browser Sermon', date: '2020-01-01', elapsed: 5, paras: [{ t: 0, lang: 'en', text: 'Imported text', refs: [] }] }] };
    const first = await call('POST', '/api/import', { cookie: adminCookie, body: payload });
    assert.equal(first.json.imported, 1);
    const second = await call('POST', '/api/import', { cookie: adminCookie, body: payload });
    assert.equal(second.json.imported, 0);
    assert.equal(second.json.skipped, 1);
});

test('deleting a sermon removes it (and its paragraphs, via the database)', async () => {
    const del = await call('DELETE', '/api/sermons/' + sermonId, { cookie: adminCookie });
    assert.equal(del.status, 200);
    const check = await call('GET', '/api/sermons/' + sermonId, { cookie: adminCookie });
    assert.equal(check.status, 404);
});

test('logging out really ends the session', async () => {
    await call('POST', '/api/auth/logout', { cookie: adminCookie });
    const r = await call('GET', '/api/auth/me', { cookie: adminCookie });
    assert.equal(r.status, 401);
});
