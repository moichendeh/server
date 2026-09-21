const db = require('../db');

// AI features need three things all true at once: a key to actually call Claude with,
// the env var kill switch (set at deploy time, e.g. to turn AI off site-wide without
// touching the database), and the admin-panel switch (a database row, so an admin can
// turn it off instantly from /admin without waiting for a redeploy).
function aiEnvConfigured() {
    return !!process.env.ANTHROPIC_API_KEY && process.env.AI_ENABLED !== 'false';
}

async function isAiEnabled() {
    if (!aiEnvConfigured()) return false;
    const row = await db.prepare('SELECT value FROM app_config WHERE key = ?').get('ai_enabled');
    return !row || row.value !== 'false';
}

module.exports = { isAiEnabled, aiEnvConfigured };
