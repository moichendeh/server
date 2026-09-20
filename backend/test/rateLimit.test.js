// This file deliberately does NOT set RATE_LIMIT_DISABLED - it exists to prove the
// limiter is really on by default (every other test file turns it off, since they
// each register/log in dozens of times on purpose).
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = 'test-secret-not-for-real-use';
process.env.DATABASE_URL = process.env.DATABASE_URL_TEST_RATELIMIT || 'postgresql://postgres:postgres@localhost:5432/sermon_scribe_test_ratelimit';
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

test('repeated login attempts eventually get rate-limited (429), not just rejected (401)', async () => {
    const attempt = () => fetch(base + '/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
        body: JSON.stringify({ email: 'nosuchuser@example.com', password: 'whatever123' })
    });
    const statuses = [];
    for (let i = 0; i < 15; i++) statuses.push((await attempt()).status);
    assert.ok(statuses.includes(429), 'expected a 429 somewhere in 15 rapid attempts, got: ' + statuses.join(','));
    assert.ok(statuses.slice(0, 10).every(s => s === 401), 'the first 10 attempts should just be normal 401s, not yet limited');
});
