const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');

process.env.JWT_SECRET = 'test-secret-not-for-real-use';
// A database of its own - node's test runner can run test files in parallel, and this
// file's DROP TABLE/recreate in test.before would otherwise race api.test.js's.
process.env.DATABASE_URL = process.env.DATABASE_URL_TEST_LIVE || 'postgresql://postgres:postgres@localhost:5432/sermon_scribe_test_live';

const db = require('../db');
const app = require('../server');

let server, base, wsBase;

test.before(async () => {
    await db.ready;
    await db.exec('DROP TABLE IF EXISTS scripture_mentions, paragraphs, sessions, sermons, bible_cache, settings, users CASCADE');
    await db.exec(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
    server = app.createServer();
    await new Promise(r => server.listen(0, r));
    base = 'http://127.0.0.1:' + server.address().port;
    wsBase = 'ws://127.0.0.1:' + server.address().port;
});
test.after(async () => {
    await new Promise(r => server.close(r));
    await db.close();
});
// A test that fails an assertion mid-way never reaches its own a.close()/b.close() -
// track every socket here so cleanup still happens regardless (server.close() in
// test.after would otherwise hang forever waiting for connections nobody closed).
const openSockets = [];
test.afterEach(async () => {
    for (const ws of openSockets) { try { ws.close(); } catch (e) {} }
    openSockets.length = 0;
    await new Promise(r => setTimeout(r, 50)); // let close handshakes finish
});

function cookieFrom(res) { return (res.headers.get('set-cookie') || '').split(';')[0]; }
async function registerAndLogin(email) {
    const res = await fetch(base + '/api/auth/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: 'correcthorsebattery' })
    });
    assert.equal(res.status, 200, 'setup: registration must succeed');
    return cookieFrom(res);
}
// The server can send its first message the instant the connection is accepted -
// before test code gets back around to attaching a listener for it. Queue every
// message from the moment the socket is created, so nothing sent early is ever missed.
function openWs(cookie) {
    const ws = new WebSocket(wsBase + '/ws', { headers: cookie ? { Cookie: cookie } : {} });
    ws._queue = [];
    ws._waiters = [];
    ws.on('message', data => {
        const msg = JSON.parse(data);
        const waiter = ws._waiters.shift();
        if (waiter) waiter(msg); else ws._queue.push(msg);
    });
    openSockets.push(ws);
    return ws;
}
function waitMsg(ws) {
    if (ws._queue.length) return Promise.resolve(ws._queue.shift());
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => {
            const i = ws._waiters.indexOf(onMsg);
            if (i !== -1) ws._waiters.splice(i, 1);
            reject(new Error('timed out waiting for a message'));
        }, 3000);
        const onMsg = msg => { clearTimeout(t); resolve(msg); };
        ws._waiters.push(onMsg);
    });
}
function waitOpen(ws) { return new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); }); }
function waitClose(ws) { return new Promise(resolve => ws.once('close', code => resolve(code))); }

test('a WebSocket connection without a valid login is rejected', async () => {
    const ws = openWs('');
    const code = await new Promise(resolve => {
        ws.once('unexpected-response', (req, res) => resolve(res.statusCode));
        ws.once('error', () => resolve('error'));
    });
    assert.equal(code, 401);
});

test('a brand new connection with nothing projected yet is told "clear"', async () => {
    const cookie = await registerAndLogin('live1@example.com');
    const ws = openWs(cookie);
    await waitOpen(ws);
    const msg = await waitMsg(ws);
    assert.equal(msg.type, 'clear');
    ws.close();
});

test('projecting from one connection reaches a second connection', async () => {
    const cookieA = await registerAndLogin('live2a@example.com');
    const cookieB = await registerAndLogin('live2b@example.com');
    const a = openWs(cookieA), b = openWs(cookieB);
    await Promise.all([waitOpen(a), waitOpen(b)]);
    await waitMsg(a); await waitMsg(b); // initial "clear" for both

    const pages = [
        [{ label: 'KJV', verses: [{ v: 16, t: 'For God so loved the world...' }], multi: false }]
    ];
    a.send(JSON.stringify({ type: 'show', ref: 'John 3:16', pages, pageIndex: 0 }));

    const gotOnA = await waitMsg(a); // A does not get its own echo suppressed - fine either way
    const gotOnB = await waitMsg(b);
    assert.equal(gotOnB.type, 'show');
    assert.equal(gotOnB.ref, 'John 3:16');
    assert.equal(gotOnB.pages[0][0].verses[0].t, 'For God so loved the world...');

    a.close(); b.close();
});

test('a late-joining connection immediately receives whatever is currently live', async () => {
    const cookieA = await registerAndLogin('live3a@example.com');
    const a = openWs(cookieA);
    await waitOpen(a); await waitMsg(a); // clear

    const pages = [[{ label: 'KJV', verses: [{ v: 1, t: 'In the beginning...' }], multi: false }]];
    a.send(JSON.stringify({ type: 'show', ref: 'Genesis 1:1', pages, pageIndex: 0 }));
    await waitMsg(a);

    const cookieLate = await registerAndLogin('live3late@example.com');
    const late = openWs(cookieLate);
    await waitOpen(late);
    const msg = await waitMsg(late);
    assert.equal(msg.type, 'show');
    assert.equal(msg.ref, 'Genesis 1:1');

    a.close(); late.close();
});

test('a projector-only connection can page Next/Previous, and everyone stays in sync', async () => {
    const cookieA = await registerAndLogin('live4a@example.com');
    const cookieB = await registerAndLogin('live4b@example.com');
    const a = openWs(cookieA), b = openWs(cookieB);
    await Promise.all([waitOpen(a), waitOpen(b)]);
    await waitMsg(a); await waitMsg(b);

    const pages = [
        [{ label: 'KJV', verses: [{ v: 1, t: 'page one' }] }],
        [{ label: 'KJV', verses: [{ v: 2, t: 'page two' }] }]
    ];
    a.send(JSON.stringify({ type: 'show', ref: 'Psalm 23', pages, pageIndex: 0 }));
    await waitMsg(a); await waitMsg(b);

    // B (acting like a standalone /projector page) asks to go to the next page.
    b.send(JSON.stringify({ type: 'nav', dir: 1 }));
    const onA = await waitMsg(a);
    const onB = await waitMsg(b);
    assert.equal(onA.type, 'page'); assert.equal(onA.pageIndex, 1);
    assert.equal(onB.type, 'page'); assert.equal(onB.pageIndex, 1);

    // Trying to go past the last page is refused, not silently ignored.
    b.send(JSON.stringify({ type: 'nav', dir: 1 }));
    const blocked = await waitMsg(b);
    assert.equal(blocked.type, 'navBlocked');

    a.close(); b.close();
});

test('the notes page can also jump straight to a page index (used by its own Next/Previous buttons)', async () => {
    const cookieA = await registerAndLogin('live5a@example.com');
    const cookieB = await registerAndLogin('live5b@example.com');
    const a = openWs(cookieA), b = openWs(cookieB);
    await Promise.all([waitOpen(a), waitOpen(b)]);
    await waitMsg(a); await waitMsg(b);

    const pages = [[{ verses: [{ v: 1, t: 'a' }] }], [{ verses: [{ v: 2, t: 'b' }] }], [{ verses: [{ v: 3, t: 'c' }] }]];
    a.send(JSON.stringify({ type: 'show', ref: 'X', pages, pageIndex: 0 }));
    await waitMsg(a); await waitMsg(b);

    a.send(JSON.stringify({ type: 'page', pageIndex: 2 }));
    const onB = await waitMsg(b);
    assert.equal(onB.type, 'page');
    assert.equal(onB.pageIndex, 2);

    // Out-of-range explicit page requests are ignored rather than corrupting state.
    a.send(JSON.stringify({ type: 'page', pageIndex: 99 }));
    let sawBadUpdate = false;
    const raceTimer = new Promise(r => setTimeout(r, 300));
    const raceMsg = waitMsg(b).then(m => { sawBadUpdate = true; return m; }).catch(() => {});
    await Promise.race([raceTimer, raceMsg]);
    assert.equal(sawBadUpdate, false, 'an out-of-range page index must not be broadcast');

    a.close(); b.close();
});

test('clearing removes the live state for everyone, including late joiners', async () => {
    const cookieA = await registerAndLogin('live6a@example.com');
    const a = openWs(cookieA);
    await waitOpen(a); await waitMsg(a);
    a.send(JSON.stringify({ type: 'show', ref: 'Y', pages: [[{ verses: [{ v: 1, t: 'z' }] }]], pageIndex: 0 }));
    await waitMsg(a);
    a.send(JSON.stringify({ type: 'clear' }));
    const cleared = await waitMsg(a);
    assert.equal(cleared.type, 'clear');

    const cookieLate = await registerAndLogin('live6late@example.com');
    const late = openWs(cookieLate);
    await waitOpen(late);
    const msg = await waitMsg(late);
    assert.equal(msg.type, 'clear');

    a.close(); late.close();
});
