require('dotenv').config();
const path = require('path');
const http = require('http');
const express = require('express');
const cookieParser = require('cookie-parser');
const attachLive = require('./live');

if (!process.env.JWT_SECRET) {
    console.error('Missing JWT_SECRET. Copy backend/.env.example to backend/.env and fill it in.');
    process.exit(1);
}

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

app.use('/api/auth', require('./routes/auth'));
app.use('/api/sermons', require('./routes/sermons'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/import', require('./routes/import'));
app.use('/api/screen-code', require('./routes/screenCode'));

app.use(express.static(path.join(__dirname, '..', 'frontend')));

// Anything that looks like a page request (not a missed API call) falls back to the app shell.
app.get(/^(?!\/api\/).*/, (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

// Express's default error page leaks stack traces - keep responses plain and safe instead.
app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ ok: false, error: 'Something went wrong on the server.' });
});

// Wraps app in a plain http.Server so the WebSocket relay (live.js) can share the
// same port - app.listen() alone would create its own server with no way to attach
// the "upgrade" handler WebSocket connections need.
function createServer() {
    const server = http.createServer(app);
    attachLive(server);
    return server;
}

if (require.main === module) {
    const db = require('./db');
    const port = process.env.PORT || 3000;
    db.ready.then(() => {
        createServer().listen(port, () => console.log(`Sermon Scribe backend listening on http://localhost:${port}`));
    });
}

module.exports = app;
module.exports.createServer = createServer;
