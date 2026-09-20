const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');

process.env.JWT_SECRET = 'test-secret-not-for-real-use';
process.env.RATE_LIMIT_DISABLED = '1';
process.env.DATABASE_URL = process.env.DATABASE_URL_TEST_LIVE || 'postgresql://postgres:postgres@localhost:5432/sermon_scribe_test_live';
process.env.ADMIN_EMAILS = '';

const db = require('../db');
const app = require('../server');

let server, base, wsBase;

test.before(async () => {
    await db.ready;
    await db.exec('DROP TABLE IF EXISTS scripture_mentions, paragraphs, sessions, login_events, sermons, bible_cache, settings, screen_codes, users CASCADE');
    await db.exec(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'db', 'migrate.sql'), 'utf8'));
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
// Rooms are per-user now, and every test below registers its own brand-new user(s) -
// so a fresh room is naturally never shared with any other test. Just close sockets a
// failed assertion left open, so server.close() above does not hang forever.
const openSockets = [];
test.afterEach(async () => {
    for (const ws of openSockets) { try { ws.close(); } catch (e) {} }
    openSockets.length = 0;
    await new Promise(r => setTimeout(r, 50));
});

function cookieFrom(res) { return (res.headers.get('set-cookie') || '').split(';')[0]; }
async function registerAndLogin(email) {
    const res = await fetch(base + '/api/auth/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
        body: JSON.stringify({ name: 'Test', email, password: 'correcthorsebattery', privacyAccepted: true })
    });
    assert.equal(res.status, 200, 'setup: registration must succeed');
    return cookieFrom(res);
}
async function getScreenCode(cookie) {
    const res = await fetch(base + '/api/screen-code', { headers: { Cookie: cookie } });
    assert.equal(res.status, 200, 'setup: fetching the screen code must succeed');
    return (await res.json()).code;
}
async function newScreenCode(cookie) {
    const res = await fetch(base + '/api/screen-code', { method: 'POST', headers: { Cookie: cookie, Origin: base } });
    assert.equal(res.status, 200, 'setup: creating a new screen code must succeed');
    return (await res.json()).code;
}
// The server can send its first message the instant the connection is accepted -
// before test code gets back around to attaching a listener for it. Queue every
// message from the moment the socket is created, so nothing sent early is ever missed.
function openWs(cookie, code) {
    const qs = code ? ('?code=' + encodeURIComponent(code)) : '';
    const ws = new WebSocket(wsBase + '/ws' + qs, { headers: cookie ? { Cookie: cookie } : {} });
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
function rejectionStatus(ws) {
    return new Promise(resolve => {
        ws.once('unexpected-response', (req, res) => resolve(res.statusCode));
        ws.once('open', () => resolve('opened'));
        ws.once('error', () => resolve('error'));
    });
}
// Watches for ms milliseconds using its OWN listener (never touching the _queue/
// _waiters used by waitMsg) - a Promise.race against waitMsg() would leave a waiter
// behind when the timer wins, which can then steal a real, later message meant for a
// subsequent waitMsg() call and make it hang. This never registers with the queue at
// all, so nothing is left behind either way.
function expectNoMessage(ws, ms) {
    return new Promise(resolve => {
        let got = false;
        const onMsg = () => { got = true; };
        ws.on('message', onMsg);
        setTimeout(() => { ws.removeListener('message', onMsg); resolve(got); }, ms);
    });
}

test('a WebSocket connection without a valid login or code is rejected', async () => {
    const ws = openWs('', '');
    assert.equal(await rejectionStatus(ws), 401);
});

test('a brand new room has nothing projected yet', async () => {
    const cookie = await registerAndLogin('live1@example.com');
    const ws = openWs(cookie);
    await waitOpen(ws);
    const msg = await waitMsg(ws);
    assert.equal(msg.type, 'clear');
});

test('projecting reaches another connection in the SAME user\'s room', async () => {
    const cookieA = await registerAndLogin('live2a@example.com');
    const a = openWs(cookieA), b = openWs(cookieA); // two devices, same account (e.g. notes page + a logged-in /projector tab)
    await Promise.all([waitOpen(a), waitOpen(b)]);
    await waitMsg(a); await waitMsg(b);

    a.send(JSON.stringify({ type: 'show', ref: 'John 3:16', pages: [[{ verses: [{ v: 16, t: 'For God so loved...' }] }]], pageIndex: 0 }));
    await waitMsg(a);
    const onB = await waitMsg(b);
    assert.equal(onB.type, 'show');
    assert.equal(onB.ref, 'John 3:16');
});

test('a verse projected by user A never reaches user B\'s room - two separate accounts, two separate rooms', async () => {
    const cookieA = await registerAndLogin('roomA@example.com');
    const cookieB = await registerAndLogin('roomB@example.com');
    const a = openWs(cookieA), b = openWs(cookieB);
    await Promise.all([waitOpen(a), waitOpen(b)]);
    await waitMsg(a); await waitMsg(b); // both start on "clear"

    a.send(JSON.stringify({ type: 'show', ref: 'Only for A', pages: [[{ verses: [{ v: 1, t: 'A only' }] }]], pageIndex: 0 }));
    await waitMsg(a); // A sees its own update

    assert.equal(await expectNoMessage(b, 300), false, 'B\'s room must never receive anything A does in A\'s own room');
});

test('B\'s screen code only ever shows B\'s room, never A\'s', async () => {
    const cookieA = await registerAndLogin('codeRoomA@example.com');
    const cookieB = await registerAndLogin('codeRoomB@example.com');
    const codeB = await getScreenCode(cookieB);

    const bScreen = openWs('', codeB); // a bare projector holding ONLY B's code
    await waitOpen(bScreen);
    await waitMsg(bScreen); // clear

    const a = openWs(cookieA);
    await waitOpen(a); await waitMsg(a);
    a.send(JSON.stringify({ type: 'show', ref: 'A\'s verse', pages: [[{ verses: [{ v: 1, t: 'should never reach B\'s screen' }] }]], pageIndex: 0 }));
    await waitMsg(a);

    assert.equal(await expectNoMessage(bScreen, 300), false);

    // Now prove B's own code DOES work for B's own room.
    const bUser = openWs(cookieB);
    await waitOpen(bUser); await waitMsg(bUser);
    bUser.send(JSON.stringify({ type: 'show', ref: 'B\'s verse', pages: [[{ verses: [{ v: 1, t: 'for B\'s screen' }] }]], pageIndex: 0 }));
    await waitMsg(bUser);
    const onBScreen = await waitMsg(bScreen);
    assert.equal(onBScreen.type, 'show');
    assert.equal(onBScreen.ref, 'B\'s verse');
});

test('a late-joining connection immediately receives whatever is currently live in that room', async () => {
    const cookieA = await registerAndLogin('live3@example.com');
    const a = openWs(cookieA);
    await waitOpen(a); await waitMsg(a);

    a.send(JSON.stringify({ type: 'show', ref: 'Genesis 1:1', pages: [[{ verses: [{ v: 1, t: 'In the beginning...' }] }]], pageIndex: 0 }));
    await waitMsg(a);

    const late = openWs(cookieA);
    await waitOpen(late);
    const msg = await waitMsg(late);
    assert.equal(msg.type, 'show');
    assert.equal(msg.ref, 'Genesis 1:1');
});

test('a projector-only connection can page Next/Previous, and stays in sync within its own room', async () => {
    const cookieA = await registerAndLogin('live4@example.com');
    const a = openWs(cookieA), b = openWs(cookieA);
    await Promise.all([waitOpen(a), waitOpen(b)]);
    await waitMsg(a); await waitMsg(b);

    const pages = [[{ verses: [{ v: 1, t: 'page one' }] }], [{ verses: [{ v: 2, t: 'page two' }] }]];
    a.send(JSON.stringify({ type: 'show', ref: 'Psalm 23', pages, pageIndex: 0 }));
    await waitMsg(a); await waitMsg(b);

    b.send(JSON.stringify({ type: 'nav', dir: 1 }));
    const onA = await waitMsg(a);
    const onB = await waitMsg(b);
    assert.equal(onA.pageIndex, 1);
    assert.equal(onB.pageIndex, 1);

    b.send(JSON.stringify({ type: 'nav', dir: 1 }));
    const blocked = await waitMsg(b);
    assert.equal(blocked.type, 'navBlocked');
});

test('clearing removes the live state for everyone in that room, including late joiners', async () => {
    const cookieA = await registerAndLogin('live5@example.com');
    const a = openWs(cookieA);
    await waitOpen(a); await waitMsg(a);
    a.send(JSON.stringify({ type: 'show', ref: 'Y', pages: [[{ verses: [{ v: 1, t: 'z' }] }]], pageIndex: 0 }));
    await waitMsg(a);
    a.send(JSON.stringify({ type: 'clear' }));
    assert.equal((await waitMsg(a)).type, 'clear');

    const late = openWs(cookieA);
    await waitOpen(late);
    assert.equal((await waitMsg(late)).type, 'clear');
});

test('a Media-role... there is no such role anymore, but a code-only viewer cannot control what is projected, even sending messages directly', async () => {
    const cookie = await registerAndLogin('code4@example.com');
    const code = await getScreenCode(cookie);

    const witness = openWs(cookie);
    await waitOpen(witness); await waitMsg(witness);

    const viewer = openWs('', code);
    await waitOpen(viewer); await waitMsg(viewer);

    viewer.send(JSON.stringify({ type: 'show', ref: 'Spoofed', pages: [[{ verses: [{ v: 1, t: 'nope' }] }]], pageIndex: 0 }));

    assert.equal(await expectNoMessage(witness, 300), false, 'a code-only "show" must be silently ignored, not broadcast');

    const check = openWs(cookie);
    await waitOpen(check);
    assert.equal((await waitMsg(check)).type, 'clear');
});

test('an invalid or stale code is rejected, and creating a new code revokes the old one', async () => {
    const cookie = await registerAndLogin('code5@example.com');
    const oldCode = await getScreenCode(cookie);

    const bad = openWs('', 'not-a-real-code');
    assert.equal(await rejectionStatus(bad), 401);

    const newCode = await newScreenCode(cookie);
    assert.notEqual(newCode, oldCode);

    const usingOld = openWs('', oldCode);
    assert.equal(await rejectionStatus(usingOld), 401);

    const usingNew = openWs('', newCode);
    await waitOpen(usingNew);
    assert.equal((await waitMsg(usingNew)).type, 'clear');
});
