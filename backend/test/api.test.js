const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = 'test-secret-not-for-real-use';
process.env.RATE_LIMIT_DISABLED = '1';
process.env.DATABASE_URL = process.env.DATABASE_URL_TEST || 'postgresql://postgres:postgres@localhost:5432/sermon_scribe_test';
process.env.ADMIN_EMAILS = 'admin@example.com';

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
async function registerAndLogin(email, opts = {}) {
    const r = await call('POST', '/api/auth/register', {
        body: { name: opts.name || 'Test User', email, password: opts.password || 'correcthorsebattery', privacyAccepted: opts.privacyAccepted !== false }
    });
    return r;
}

test('registering with the ADMIN_EMAILS address becomes an Admin - not "the first account"', async () => {
    const notFirst = await registerAndLogin('someone-else@example.com');
    assert.equal(notFirst.status, 200);
    assert.equal(notFirst.json.user.role, 'user', 'registering first must NOT grant admin');

    const admin = await registerAndLogin('admin@example.com');
    assert.equal(admin.status, 200);
    assert.equal(admin.json.user.role, 'admin', 'an ADMIN_EMAILS address must become admin, regardless of order');
});

test('registration requires a name, a valid email, a 10+ character password, and privacy acceptance', async () => {
    const noName = await call('POST', '/api/auth/register', { body: { email: 'a1@example.com', password: 'correcthorsebattery', privacyAccepted: true } });
    assert.equal(noName.status, 400);

    const badEmail = await call('POST', '/api/auth/register', { body: { name: 'A', email: 'not-an-email', password: 'correcthorsebattery', privacyAccepted: true } });
    assert.equal(badEmail.status, 400);

    const shortPw = await call('POST', '/api/auth/register', { body: { name: 'A', email: 'a2@example.com', password: 'short123', privacyAccepted: true } });
    assert.equal(shortPw.status, 400);

    const noPrivacy = await call('POST', '/api/auth/register', { body: { name: 'A', email: 'a3@example.com', password: 'correcthorsebattery', privacyAccepted: false } });
    assert.equal(noPrivacy.status, 400);
});

test('emails are unique regardless of upper/lower case', async () => {
    await registerAndLogin('CaseTest@Example.com');
    const dup = await call('POST', '/api/auth/register', { body: { name: 'Dup', email: 'casetest@example.com', password: 'correcthorsebattery', privacyAccepted: true } });
    assert.equal(dup.status, 409);
});

test('passwords are never stored in plain text', async () => {
    await registerAndLogin('hashcheck@example.com', { password: 'correcthorsebattery' });
    const row = await db.prepare('SELECT password_hash FROM users WHERE email = ?').get('hashcheck@example.com');
    assert.ok(row.password_hash !== 'correcthorsebattery');
    assert.ok(row.password_hash.startsWith('$2'), 'expected a bcrypt hash');
});

test('wrong password is rejected, and a request with no login at all is rejected', async () => {
    const wrong = await call('POST', '/api/auth/login', { body: { email: 'hashcheck@example.com', password: 'wrongpassword123' } });
    assert.equal(wrong.status, 401);
    const noAuth = await call('GET', '/api/auth/me');
    assert.equal(noAuth.status, 401);
});

test('a cross-site request (wrong Origin) making a state-changing call is rejected', async () => {
    const res = await fetch(base + '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example.com' },
        body: JSON.stringify({ email: 'hashcheck@example.com', password: 'correcthorsebattery' })
    });
    assert.equal(res.status, 403);
});

test('login records last_login_at, increments login_count, and logs a login event with no IP address', async () => {
    const email = 'loginevents@example.com';
    await registerAndLogin(email); // registering counts as login #1
    await call('POST', '/api/auth/login', { body: { email, password: 'correcthorsebattery' } }); // login #2
    const user = await db.prepare('SELECT id, login_count, last_login_at FROM users WHERE email = ?').get(email);
    assert.equal(user.login_count, 2);
    assert.ok(user.last_login_at);
    const events = await db.prepare('SELECT * FROM login_events WHERE user_id = ?').all(user.id);
    assert.equal(events.length, 2);
    assert.equal(Object.keys(events[0]).some(k => k.toLowerCase().includes('ip')), false, 'no IP-address column must exist');
});

test('a disabled account cannot log in, and an existing session stops working the moment it is disabled', async () => {
    const email = 'disableme@example.com';
    const reg = await registerAndLogin(email);
    const cookie = reg.cookie;
    const me1 = await call('GET', '/api/auth/me', { cookie });
    assert.equal(me1.status, 200);

    const row = await db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    await db.prepare('UPDATE users SET is_disabled = true WHERE id = ?').run(row.id);

    const me2 = await call('GET', '/api/auth/me', { cookie });
    assert.equal(me2.status, 401, 'an existing cookie must stop working once the account is disabled');

    const loginAttempt = await call('POST', '/api/auth/login', { body: { email, password: 'correcthorsebattery' } });
    assert.equal(loginAttempt.status, 403);
});

let userCookie, sermonId, updatedAt;

test('a logged-in user can create a sermon and save paragraphs with scripture references', async () => {
    const reg = await registerAndLogin('sermonuser@example.com');
    userCookie = reg.cookie;
    const created = await call('POST', '/api/sermons', { cookie: userCookie, body: { title: 'Test Sermon', date: '2026-09-20' } });
    assert.equal(created.status, 200);
    sermonId = created.json.sermon.id;
    updatedAt = created.json.sermon.updatedAt;

    const saved = await call('PATCH', '/api/sermons/' + sermonId, {
        cookie: userCookie,
        body: {
            elapsed: 42, baseUpdatedAt: updatedAt,
            paragraphs: [
                { t: 0, lang: 'en', text: 'Good morning church.', refs: [] },
                { t: 10, lang: 'en', text: 'Turn to John chapter 3 verse 16.', refs: [{ bookNr: 43, chapter: 3, from: 16, to: 16 }] }
            ]
        }
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.sermon.paragraphs.length, 2);
    assert.deepEqual(saved.json.sermon.paragraphs[1].refs, [{ bookNr: 43, chapter: 3, from: 16, to: 16 }]);
    updatedAt = saved.json.sermon.updatedAt;
});

test('a fresh GET returns exactly what was saved, and every paragraph/mention row carries the owner\'s user_id', async () => {
    const check = await call('GET', '/api/sermons/' + sermonId, { cookie: userCookie });
    assert.equal(check.json.sermon.paragraphs[0].text, 'Good morning church.');

    const row = await db.prepare('SELECT user_id FROM sermons WHERE id = ?').get(sermonId);
    const paraRows = await db.prepare('SELECT user_id FROM paragraphs WHERE sermon_id = ?').all(sermonId);
    const mentionRows = await db.prepare('SELECT user_id FROM scripture_mentions WHERE sermon_id = ?').all(sermonId);
    assert.ok(row.user_id);
    assert.ok(paraRows.every(p => p.user_id === row.user_id));
    assert.ok(mentionRows.every(m => m.user_id === row.user_id));
});

test('saving with a stale baseUpdatedAt is rejected as a conflict, and does not corrupt the data', async () => {
    const stale = await call('PATCH', '/api/sermons/' + sermonId, {
        cookie: userCookie,
        body: { paragraphs: [{ t: 0, lang: 'en', text: 'A stale writer', refs: [] }], baseUpdatedAt: 'not-the-real-timestamp' }
    });
    assert.equal(stale.status, 409);
    const check = await call('GET', '/api/sermons/' + sermonId, { cookie: userCookie });
    assert.equal(check.json.sermon.paragraphs[0].text, 'Good morning church.');
});

test('settings are per-user: defaults, then a patch persists for that user only', async () => {
    const before = await call('GET', '/api/settings', { cookie: userCookie });
    assert.equal(before.json.settings.projMode, 'ask');
    await call('PATCH', '/api/settings', { cookie: userCookie, body: { projMode: 'auto' } });
    const after = await call('GET', '/api/settings', { cookie: userCookie });
    assert.equal(after.json.settings.projMode, 'auto');
});

test('importing old browser sermons adds them to the logged-in user\'s own account, and re-importing is skipped', async () => {
    const payload = { sermons: [{ title: 'Old Browser Sermon', date: '2020-01-01', elapsed: 5, paras: [{ t: 0, lang: 'en', text: 'Imported text', refs: [] }] }] };
    const first = await call('POST', '/api/import', { cookie: userCookie, body: payload });
    assert.equal(first.json.imported, 1);
    const second = await call('POST', '/api/import', { cookie: userCookie, body: payload });
    assert.equal(second.json.imported, 0);
    assert.equal(second.json.skipped, 1);

    const list = await call('GET', '/api/sermons', { cookie: userCookie });
    const imported = list.json.sermons.find(s => s.title === 'Old Browser Sermon');
    assert.ok(imported);
    const row = await db.prepare('SELECT user_id FROM sermons WHERE id = ?').get(imported.id);
    const meRow = await db.prepare('SELECT id FROM users WHERE email = ?').get('sermonuser@example.com');
    assert.equal(row.user_id, meRow.id);
});

test('deleting a sermon removes it and its paragraphs/mentions', async () => {
    const del = await call('DELETE', '/api/sermons/' + sermonId, { cookie: userCookie });
    assert.equal(del.status, 200);
    const check = await call('GET', '/api/sermons/' + sermonId, { cookie: userCookie });
    assert.equal(check.status, 404);
    const paraRows = await db.prepare('SELECT * FROM paragraphs WHERE sermon_id = ?').all(sermonId);
    assert.equal(paraRows.length, 0);
});

test('logging out really ends the session', async () => {
    await call('POST', '/api/auth/logout', { cookie: userCookie });
    const r = await call('GET', '/api/auth/me', { cookie: userCookie });
    assert.equal(r.status, 401);
});
