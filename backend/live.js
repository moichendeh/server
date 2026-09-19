// The live "what's on the projector right now" channel. Any logged-in device (the
// notes page, or a standalone /projector page) connects here over WebSocket. Whoever
// projects a verse sends it here once; the server remembers it and relays it to every
// other connected device, so every screen updates together.
//
// The server never fetches Bible text itself - the notes page does that (it already
// knows how) and sends the already-fetched verse text/pages. A /projector-only device
// (no notes access) can still page through the pages it was already sent (Next/
// Previous/Clear), it just can't jump to a *different* verse on its own.
const { WebSocketServer } = require('ws');
const cookie = require('cookie');
const jwt = require('jsonwebtoken');
const db = require('./db');

async function authenticate(req) {
    try {
        const cookies = cookie.parse(req.headers.cookie || '');
        const token = cookies.ss_token;
        if (!token) return null;
        const payload = jwt.verify(token, process.env.JWT_SECRET);
        const row = await db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(payload.jti);
        return row ? payload : null;
    } catch (e) {
        return null;
    }
}

function attachLive(server) {
    const wss = new WebSocketServer({ noServer: true });
    const clients = new Set();
    let currentLive = null; // { ref, pages, pageIndex } | null

    server.on('upgrade', async (req, socket, head) => {
        if (!req.url.startsWith('/ws')) return;
        const user = await authenticate(req);
        if (!user) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
        }
        wss.handleUpgrade(req, socket, head, ws => {
            clients.add(ws);
            ws.send(JSON.stringify(currentLive ? { type: 'show', ...currentLive } : { type: 'clear' }));
            ws.on('message', raw => handleMessage(ws, raw));
            ws.on('close', () => clients.delete(ws));
        });
    });

    function broadcast(msg) {
        const data = JSON.stringify(msg);
        for (const c of clients) if (c.readyState === c.OPEN) c.send(data);
    }

    function handleMessage(ws, raw) {
        let msg;
        try { msg = JSON.parse(raw); } catch (e) { return; }

        if (msg.type === 'show' && Array.isArray(msg.pages)) {
            currentLive = { ref: msg.ref, pages: msg.pages, pageIndex: Number(msg.pageIndex) || 0 };
            broadcast({ type: 'show', ...currentLive });
        } else if (msg.type === 'clear') {
            currentLive = null;
            broadcast({ type: 'clear' });
        } else if (msg.type === 'page' && currentLive) {
            const p = Number(msg.pageIndex);
            if (!Number.isInteger(p) || p < 0 || p >= currentLive.pages.length) return;
            currentLive.pageIndex = p;
            broadcast({ type: 'page', pageIndex: p });
        } else if (msg.type === 'nav' && currentLive) {
            const next = currentLive.pageIndex + (msg.dir > 0 ? 1 : -1);
            if (next < 0 || next >= currentLive.pages.length) {
                ws.send(JSON.stringify({ type: 'navBlocked' }));
                return;
            }
            currentLive.pageIndex = next;
            broadcast({ type: 'page', pageIndex: next });
        }
    }
}

module.exports = attachLive;
