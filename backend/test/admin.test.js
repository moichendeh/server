const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = 'test-secret-not-for-real-use';
process.env.RATE_LIMIT_DISABLED = '1';
process.env.DATABASE_URL = process.env.DATABASE_URL_TEST_ADMIN || 'postgresql://postgres:postgres@localhost:5432/sermon_scribe_test_admin';
process.env.ADMIN_EMAILS = 'boss@example.com';

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
async function newUser(email, name) {
    const r = await call('POST', '/api/auth/register', { body: { name: name || 'Test', email, password: 'correcthorsebattery', privacyAccepted: true } });
    assert.equal(r.status, 200, 'setup: registration must succeed');
    return r;
}

let adminCookie, aliceCookie, aliceId;

// One before() hook - everything here must finish, in order, before any test runs.
test.before(async () => {
    await db.ready;
    await db.exec('DROP TABLE IF EXISTS scripture_mentions, paragraphs, sessions, login_events, sermons, bible_cache, settings, screen_codes, users CASCADE');
    await db.exec(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'db', 'migrate.sql'), 'utf8'));
    await db.exec(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
    server = app.listen(0);
    await new Promise(r => server.once('listening', r));
    base = 'http://127.0.0.1:' + server.address().port;

    adminCookie = (await newUser('boss@example.com', 'The Boss')).cookie;
    const alice = await newUser('alice@example.com', 'Alice Example');
    aliceCookie = alice.cookie;
    aliceId = alice.json.user.id;
    await call('POST', '/api/sermons', { cookie: aliceCookie, body: { title: 'Alices Sermon', date: '2026-01-01' } });
});
test.after(async () => {
    await new Promise(r => server.close(r));
    await db.close();
});

test('a regular user cannot reach any /api/admin endpoint', async () => {
    const list = await call('GET', '/api/admin/users', { cookie: aliceCookie });
    assert.equal(list.status, 403);
    const disable = await call('POST', '/api/admin/users/' + aliceId + '/disable', { cookie: aliceCookie });
    assert.equal(disable.status, 403);
});

test('an unauthenticated request to /api/admin is rejected, not just forbidden', async () => {
    const r = await call('GET', '/api/admin/users');
    assert.equal(r.status, 401);
});

test('the admin user list includes name, email, dates, login count, sermon count and status - never sermon content', async () => {
    const list = await call('GET', '/api/admin/users', { cookie: adminCookie });
    assert.equal(list.status, 200);
    const alice = list.json.users.find(u => u.email === 'alice@example.com');
    assert.ok(alice);
    assert.equal(alice.name, 'Alice Example');
    assert.equal(alice.sermonCount, 1);
    assert.equal(alice.isDisabled, false);
    assert.ok('createdAt' in alice && 'loginCount' in alice);
    assert.equal(JSON.stringify(list.json).includes('Alices Sermon'), false, 'sermon titles/content must never appear in the admin list');
});

test('search filters the user list by name or email', async () => {
    const bySearch = await call('GET', '/api/admin/users?search=alice', { cookie: adminCookie });
    assert.ok(bySearch.json.users.every(u => /alice/i.test(u.name) || /alice/i.test(u.email)));
    assert.ok(bySearch.json.users.length >= 1);
});

test('an admin can disable an account, which logs it out immediately and blocks future logins', async () => {
    const disable = await call('POST', '/api/admin/users/' + aliceId + '/disable', { cookie: adminCookie });
    assert.equal(disable.status, 200);

    const meAfter = await call('GET', '/api/auth/me', { cookie: aliceCookie });
    assert.equal(meAfter.status, 401);

    const loginAttempt = await call('POST', '/api/auth/login', { body: { email: 'alice@example.com', password: 'correcthorsebattery' } });
    assert.equal(loginAttempt.status, 403);
});

test('an admin can re-enable an account, which can then log in again', async () => {
    const enable = await call('POST', '/api/admin/users/' + aliceId + '/enable', { cookie: adminCookie });
    assert.equal(enable.status, 200);
    const login = await call('POST', '/api/auth/login', { body: { email: 'alice@example.com', password: 'correcthorsebattery' } });
    assert.equal(login.status, 200);
});

test('an admin cannot disable or delete their own account through this endpoint', async () => {
    const adminMe = await call('GET', '/api/auth/me', { cookie: adminCookie });
    const disableSelf = await call('POST', '/api/admin/users/' + adminMe.json.user.id + '/disable', { cookie: adminCookie });
    assert.equal(disableSelf.status, 400);
    const deleteSelf = await call('DELETE', '/api/admin/users/' + adminMe.json.user.id, { cookie: adminCookie });
    assert.equal(deleteSelf.status, 400);
});

test('deleting a user removes their account and all their sermons/paragraphs/mentions', async () => {
    const del = await call('DELETE', '/api/admin/users/' + aliceId, { cookie: adminCookie });
    assert.equal(del.status, 200);

    const userRow = await db.prepare('SELECT * FROM users WHERE id = ?').get(aliceId);
    assert.equal(userRow, undefined);
    const sermonRows = await db.prepare('SELECT * FROM sermons WHERE user_id = ?').all(aliceId);
    assert.equal(sermonRows.length, 0);

    const login = await call('POST', '/api/auth/login', { body: { email: 'alice@example.com', password: 'correcthorsebattery' } });
    assert.equal(login.status, 401);
});
