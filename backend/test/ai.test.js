const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = 'test-secret-not-for-real-use';
process.env.RATE_LIMIT_DISABLED = '1';
process.env.DATABASE_URL = process.env.DATABASE_URL_TEST_AI || 'postgresql://postgres:postgres@localhost:5432/sermon_scribe_test_ai';
process.env.ADMIN_EMAILS = 'aiadmin@example.com';
process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
process.env.AI_ENABLED = 'true';
process.env.AI_DAILY_CHAR_LIMIT = '150000';
process.env.AI_DAILY_REQUEST_LIMIT = '1000';

const db = require('../db');
const app = require('../server');

// No real Anthropic account/key in this test environment - stand in for the Messages
// API with a canned response the test can change between calls, and let every other
// fetch (the test's own calls into our local server) through untouched. This never
// contacts api.anthropic.com and costs nothing.
const realFetch = global.fetch;
let nextAnthropicReply = () => ({ corrected: 'Fixed text.', translated: null });
let anthropicCalls = 0;
global.fetch = async (url, opts) => {
    const s = String(url);
    if (s.startsWith('https://api.anthropic.com/')) {
        anthropicCalls++;
        const reply = nextAnthropicReply();
        if (reply instanceof Error) throw reply;
        if (reply.httpStatus) {
            return { ok: false, status: reply.httpStatus, headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({ error: { message: 'mock error' } }), text: async () => 'mock error' };
        }
        const raw = reply.raw !== undefined ? reply.raw : JSON.stringify(reply);
        const body = {
            id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-haiku-4-5',
            content: [{ type: 'text', text: raw }],
            stop_reason: 'end_turn', stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 10 }
        };
        return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => body, text: async () => JSON.stringify(body) };
    }
    return realFetch(url, opts);
};

let server, base;
test.before(async () => {
    await db.ready;
    await db.exec('DROP TABLE IF EXISTS ai_usage, app_config, scripture_mentions, paragraphs, sessions, login_events, sermons, bible_cache, settings, screen_codes, users CASCADE');
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
const knownEmails = new Set();
async function registerAndLogin(email) {
    if (knownEmails.has(email)) {
        return call('POST', '/api/auth/login', { body: { email, password: 'correcthorsebattery' } });
    }
    knownEmails.add(email);
    return call('POST', '/api/auth/register', { body: { name: 'T', email, password: 'correcthorsebattery', privacyAccepted: true } });
}

test('an unauthenticated request is rejected', async () => {
    const r = await call('POST', '/api/ai/process', { body: { text: 'hello', lang: 'en', correct: true } });
    assert.equal(r.status, 401);
});

test('correcting sample English text', async () => {
    const u = await registerAndLogin('ai-en@example.com');
    nextAnthropicReply = () => ({ corrected: 'This is corrected English text.', translated: null });
    const r = await call('POST', '/api/ai/process', { body: { text: 'this is korected english txt', lang: 'en', correct: true }, cookie: u.cookie });
    assert.equal(r.status, 200);
    assert.equal(r.json.corrected, 'This is corrected English text.');
    assert.equal(r.json.translated, null);
    assert.equal(r.json.draft, false);
});

test('correcting sample German text', async () => {
    const u = await registerAndLogin('ai-de@example.com');
    nextAnthropicReply = () => ({ corrected: 'Dies ist korrigierter deutscher Text.', translated: null });
    const r = await call('POST', '/api/ai/process', { body: { text: 'dis ist korrigirte deutch text', lang: 'de', correct: true }, cookie: u.cookie });
    assert.equal(r.status, 200);
    assert.equal(r.json.corrected, 'Dies ist korrigierter deutscher Text.');
});

test('translating German to English is not marked draft', async () => {
    const u = await registerAndLogin('ai-de-en@example.com');
    nextAnthropicReply = () => ({ corrected: 'Der Herr ist mein Hirte.', translated: 'The Lord is my shepherd.' });
    const r = await call('POST', '/api/ai/process', { body: { text: 'der herr ist mein hirt', lang: 'de', correct: true, translateTo: 'en' }, cookie: u.cookie });
    assert.equal(r.status, 200);
    assert.equal(r.json.translated, 'The Lord is my shepherd.');
    assert.equal(r.json.draft, false, 'German<->English is not a lower-confidence pair');
});

test('translating to Krio is marked as a draft translation', async () => {
    const u = await registerAndLogin('ai-kri@example.com');
    nextAnthropicReply = () => ({ corrected: 'The Lord is my shepherd.', translated: 'Di Lohd na mi shephed.' });
    const r = await call('POST', '/api/ai/process', { body: { text: 'the lord is my sheperd', lang: 'en', correct: true, translateTo: 'kri' }, cookie: u.cookie });
    assert.equal(r.status, 200);
    assert.equal(r.json.translated, 'Di Lohd na mi shephed.');
    assert.equal(r.json.draft, true, 'Krio translations must always be flagged as a draft');
});

test('sample Krio text typed by hand can also be corrected', async () => {
    const u = await registerAndLogin('ai-kri2@example.com');
    nextAnthropicReply = () => ({ corrected: 'Tenki fɔ kam.', translated: null });
    const r = await call('POST', '/api/ai/process', { body: { text: 'tenki fo kam', lang: 'kri', correct: true }, cookie: u.cookie });
    assert.equal(r.status, 200);
    assert.equal(r.json.corrected, 'Tenki fɔ kam.');
});

test('a garbled AI response degrades to "nothing changed", never a crash', async () => {
    const u = await registerAndLogin('ai-garbled@example.com');
    nextAnthropicReply = () => ({ raw: 'not json at all, just prose' });
    const r = await call('POST', '/api/ai/process', { body: { text: 'some text', lang: 'en', correct: true }, cookie: u.cookie });
    assert.equal(r.status, 200);
    assert.equal(r.json.corrected, null);
});

test('an Anthropic API failure is reported cleanly and does not lose the original text', async () => {
    const u = await registerAndLogin('ai-fail@example.com');
    nextAnthropicReply = () => ({ httpStatus: 500 });
    const r = await call('POST', '/api/ai/process', { body: { text: 'some text', lang: 'en', correct: true }, cookie: u.cookie });
    assert.equal(r.status, 502);
    assert.match(r.json.error, /original text is unchanged/);
});

test('no text and no request are both handled without calling the AI at all', async () => {
    const u = await registerAndLogin('ai-notext@example.com');
    const before = anthropicCalls;
    const r1 = await call('POST', '/api/ai/process', { body: { text: '', lang: 'en', correct: true }, cookie: u.cookie });
    assert.equal(r1.status, 400);
    const r2 = await call('POST', '/api/ai/process', { body: { text: 'hello', lang: 'en', correct: false, translateTo: 'none' }, cookie: u.cookie });
    assert.equal(r2.status, 200);
    assert.equal(r2.json.corrected, null);
    assert.equal(anthropicCalls, before, 'neither request should have reached the AI service');
});

test('the daily character limit blocks further requests and says notes are still saved', async () => {
    const u = await registerAndLogin('ai-limit@example.com');
    nextAnthropicReply = () => ({ corrected: 'ok', translated: null });
    process.env.AI_DAILY_CHAR_LIMIT = '10';
    const r1 = await call('POST', '/api/ai/process', { body: { text: 'twelve chars', lang: 'en', correct: true }, cookie: u.cookie });
    assert.equal(r1.status, 429);
    assert.match(r1.json.error, /today's limit/);
    assert.match(r1.json.error, /still saved/);
    process.env.AI_DAILY_CHAR_LIMIT = '150000';
});

test('an admin can turn AI features off instantly, without an env var change', async () => {
    const admin = await registerAndLogin('aiadmin@example.com');
    assert.equal((await call('GET', '/api/auth/me', { cookie: admin.cookie })).json.user.role, 'admin');

    const off = await call('POST', '/api/admin/ai-config', { body: { enabled: false }, cookie: admin.cookie });
    assert.equal(off.status, 200);
    assert.equal(off.json.effectiveEnabled, false);

    const u = await registerAndLogin('ai-toggled@example.com');
    const r = await call('POST', '/api/ai/process', { body: { text: 'hello there', lang: 'en', correct: true }, cookie: u.cookie });
    assert.equal(r.status, 503);

    const on = await call('POST', '/api/admin/ai-config', { body: { enabled: true }, cookie: admin.cookie });
    assert.equal(on.json.effectiveEnabled, true);
    const r2 = await call('POST', '/api/ai/process', { body: { text: 'hello there', lang: 'en', correct: true }, cookie: u.cookie });
    assert.equal(r2.status, 200);
});

test('AI usage (counts only) shows up on the admin user list', async () => {
    const admin = await registerAndLogin('aiadmin@example.com');
    const list = await call('GET', '/api/admin/users', { cookie: admin.cookie });
    assert.equal(list.status, 200);
    const enUser = list.json.users.find(u => u.email === 'ai-en@example.com');
    assert.ok(enUser, 'the user who made an AI request earlier must appear');
    assert.ok(enUser.aiRequests >= 1);
    assert.ok(enUser.aiChars >= 1);
});

test('with no ANTHROPIC_API_KEY, AI features report as unavailable rather than erroring', async () => {
    const u = await registerAndLogin('ai-nokey@example.com');
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const status = await call('GET', '/api/ai/status', { cookie: u.cookie });
    assert.equal(status.json.enabled, false);
    const r = await call('POST', '/api/ai/process', { body: { text: 'hello there', lang: 'en', correct: true }, cookie: u.cookie });
    assert.equal(r.status, 503);
    process.env.ANTHROPIC_API_KEY = saved;
});
