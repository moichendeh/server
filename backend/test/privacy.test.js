const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = 'test-secret-not-for-real-use';
process.env.RATE_LIMIT_DISABLED = '1';
process.env.DATABASE_URL = process.env.DATABASE_URL_TEST_PRIVACY || 'postgresql://postgres:postgres@localhost:5432/sermon_scribe_test_privacy';
process.env.ADMIN_EMAILS = '';

const db = require('../db');
const app = require('../server');

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
});

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

test('registering without accepting the privacy notice is rejected', async () => {
    const r = await call('POST', '/api/auth/register', { body: { name: 'P', email: 'nopriv@example.com', password: 'correcthorsebattery', privacyAccepted: false } });
    assert.equal(r.status, 400);
});

test('registering records when the privacy notice was accepted', async () => {
    const r = await call('POST', '/api/auth/register', { body: { name: 'P', email: 'yespriv@example.com', password: 'correcthorsebattery', privacyAccepted: true } });
    assert.equal(r.status, 200);
    const row = await db.prepare('SELECT privacy_accepted_at FROM users WHERE email = ?').get('yespriv@example.com');
    assert.ok(row.privacy_accepted_at);
});

let cookie, sermonId;
test('"Download my data" returns this user\'s own sermons, settings, and account info as JSON', async () => {
    const reg = await call('POST', '/api/auth/register', { body: { name: 'Dana', email: 'exportme@example.com', password: 'correcthorsebattery', privacyAccepted: true } });
    cookie = reg.cookie;
    const created = await call('POST', '/api/sermons', { cookie, body: { title: 'My Export Test', date: '2026-02-02' } });
    sermonId = created.json.sermon.id;
    await call('PATCH', '/api/settings', { cookie, body: { projMode: 'voice' } });

    const exported = await call('GET', '/api/me/export', { cookie });
    assert.equal(exported.status, 200);
    assert.equal(exported.json.user.email, 'exportme@example.com');
    assert.ok(exported.json.sermons.some(s => s.title === 'My Export Test'));
    assert.equal(exported.json.settings.projMode, 'voice');
    assert.equal('password_hash' in exported.json.user, false, 'the export must never include the password hash');
});

test('"Delete my account" removes the account, its sermons, and logs the browser out', async () => {
    const del = await call('DELETE', '/api/me', { cookie });
    assert.equal(del.status, 200);

    const row = await db.prepare('SELECT * FROM users WHERE email = ?').get('exportme@example.com');
    assert.equal(row, undefined);
    const sermonRow = await db.prepare('SELECT * FROM sermons WHERE id = ?').get(sermonId);
    assert.equal(sermonRow, undefined);

    const me = await call('GET', '/api/auth/me', { cookie });
    assert.equal(me.status, 401);
});
