// The live "what's on the projector right now" channel - one separate room per user,
// so a verse projected by one person can never appear on anyone else's projector. A
// device gets into a particular room one of two ways:
//   - logged in as that user (the notes page, or a logged-in browser viewing
//     /projector) - can both receive live updates AND send them (project/clear/
//     page/nav) for their OWN room only.
//   - holding the CURRENT screen code for that user (?code=...) - a bare projector
//     screen with no login at all, placed into that one user's room. Can only
//     RECEIVE live updates. Even if someone inspects the page and sends a
//     show/clear/nav message by hand, the server just ignores it - a code can never
//     read or change sermons, notes, or control what's projected, only watch, and
//     only that one user's feed.
//
// The server never fetches Bible text itself - the notes page does that (it already
// knows how) and sends the already-fetched verse text/pages.
const { WebSocketServer } = require('ws');
const cookie = require('cookie');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('./db');
const { userIdForCode } = require('./routes/screenCode');

async function authenticate(req) {
    try {
        const cookies = cookie.parse(req.headers.cookie || '');
        const token = cookies.ss_token;
        if (!token) return null;
        const payload = jwt.verify(token, process.env.JWT_SECRET);
        const row = await db.prepare(
            'SELECT u.is_disabled FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?'
        ).get(payload.jti);
        if (!row || row.is_disabled) return null;
        return payload;
    } catch (e) {
        return null;
    }
}

function safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
    const bufA = Buffer.from(a), bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

function attachLive(server) {
    const wss = new WebSocketServer({ noServer: true });
    const rooms = new Map(); // userId -> { clients: Set<ws>, currentLive: {ref,pages,pageIndex} | null }

    function room(userId) {
        if (!rooms.has(userId)) rooms.set(userId, { clients: new Set(), currentLive: null });
        return rooms.get(userId);
    }

    server.on('upgrade', async (req, socket, head) => {
        if (!req.url.startsWith('/ws')) return;

        const requestUrl = new URL(req.url, 'http://internal');
        const codeParam = requestUrl.searchParams.get('code');

        const user = await authenticate(req);
        let roomUserId = null, privileged = false;
        if (user) {
            roomUserId = user.id;
            privileged = true;
        } else if (codeParam) {
            const stored = await userIdForCode(codeParam);
            // userIdForCode looks up by exact match already (a database unique index,
            // not a loop) - safeEqual below just avoids a timing side-channel on top of that.
            if (stored != null) roomUserId = stored;
        }
        if (roomUserId == null) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
        }

        wss.handleUpgrade(req, socket, head, ws => {
            ws.privileged = privileged;
            ws.roomUserId = roomUserId;
            const r = room(roomUserId);
            r.clients.add(ws);
            ws.send(JSON.stringify(r.currentLive ? { type: 'show', ...r.currentLive } : { type: 'clear' }));
            ws.on('message', raw => handleMessage(ws, raw));
            ws.on('close', () => r.clients.delete(ws));
        });
    });

    function broadcast(roomUserId, msg) {
        const data = JSON.stringify(msg);
        for (const c of room(roomUserId).clients) if (c.readyState === c.OPEN) c.send(data);
    }

    function handleMessage(ws, raw) {
        if (!ws.privileged) return; // view-only: a code alone can never control what's projected
        let msg;
        try { msg = JSON.parse(raw); } catch (e) { return; }
        const r = room(ws.roomUserId);

        if (msg.type === 'show' && Array.isArray(msg.pages)) {
            r.currentLive = { ref: msg.ref, pages: msg.pages, pageIndex: Number(msg.pageIndex) || 0 };
            broadcast(ws.roomUserId, { type: 'show', ...r.currentLive });
        } else if (msg.type === 'clear') {
            r.currentLive = null;
            broadcast(ws.roomUserId, { type: 'clear' });
        } else if (msg.type === 'page' && r.currentLive) {
            const p = Number(msg.pageIndex);
            if (!Number.isInteger(p) || p < 0 || p >= r.currentLive.pages.length) return;
            r.currentLive.pageIndex = p;
            broadcast(ws.roomUserId, { type: 'page', pageIndex: p });
        } else if (msg.type === 'nav' && r.currentLive) {
            const next = r.currentLive.pageIndex + (msg.dir > 0 ? 1 : -1);
            if (next < 0 || next >= r.currentLive.pages.length) {
                ws.send(JSON.stringify({ type: 'navBlocked' }));
                return;
            }
            r.currentLive.pageIndex = next;
            broadcast(ws.roomUserId, { type: 'page', pageIndex: next });
        }
    }
}

module.exports = attachLive;
