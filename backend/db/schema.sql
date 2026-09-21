-- PostgreSQL. Dates are stored as plain text in "YYYY-MM-DD HH:MM:SS" - the shape this
-- app has always used - so nothing that reads/compares them needs to know or care
-- that the database is Postgres rather than SQLite.
--
-- Every table that holds anything a person typed or projected has a user_id column,
-- and every query the server runs filters by it. See migrate.sql for how an existing
-- (older, single-church) database gets upgraded to this shape without losing data.

CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    is_disabled BOOLEAN NOT NULL DEFAULT false,
    privacy_accepted_at TEXT,
    last_login_at TEXT,
    login_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (to_char(now(), 'YYYY-MM-DD HH24:MI:SS'))
);

-- One row per logged-in device/browser. A login's cookie only works while its row is
-- here; logging out deletes the row, so the cookie stops working immediately (a plain
-- login token on its own can't be "un-issued", so this is what makes logout real).
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (to_char(now(), 'YYYY-MM-DD HH24:MI:SS'))
);

-- One row every time someone logs in successfully - no IP address, on purpose.
CREATE TABLE IF NOT EXISTS login_events (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    occurred_at TEXT NOT NULL DEFAULT (to_char(now(), 'YYYY-MM-DD HH24:MI:SS')),
    user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_login_events_user ON login_events(user_id);

CREATE TABLE IF NOT EXISTS sermons (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    title TEXT NOT NULL DEFAULT '',
    date TEXT NOT NULL DEFAULT '',
    elapsed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (to_char(now(), 'YYYY-MM-DD HH24:MI:SS')),
    updated_at TEXT NOT NULL DEFAULT (to_char(now(), 'YYYY-MM-DD HH24:MI:SS'))
);
CREATE INDEX IF NOT EXISTS idx_sermons_user ON sermons(user_id);

CREATE TABLE IF NOT EXISTS paragraphs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    sermon_id INTEGER NOT NULL REFERENCES sermons(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    t INTEGER NOT NULL DEFAULT 0,
    lang TEXT NOT NULL DEFAULT 'en',
    speaker TEXT,
    text TEXT NOT NULL DEFAULT '',
    -- AI correction/translation (see routes/ai.js) - "text" above is always exactly
    -- what was recognized/typed, never touched by the AI; these are its output,
    -- stored alongside it, never replacing it.
    corrected_text TEXT,
    translated_text TEXT,
    translated_lang TEXT,
    created_at TEXT NOT NULL DEFAULT (to_char(now(), 'YYYY-MM-DD HH24:MI:SS'))
);
CREATE INDEX IF NOT EXISTS idx_paragraphs_sermon ON paragraphs(sermon_id, seq);
CREATE INDEX IF NOT EXISTS idx_paragraphs_user ON paragraphs(user_id);

CREATE TABLE IF NOT EXISTS scripture_mentions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    sermon_id INTEGER NOT NULL REFERENCES sermons(id) ON DELETE CASCADE,
    paragraph_id INTEGER REFERENCES paragraphs(id) ON DELETE CASCADE,
    book_nr INTEGER NOT NULL,
    chapter INTEGER NOT NULL,
    from_verse INTEGER,
    to_verse INTEGER,
    whole INTEGER NOT NULL DEFAULT 0,
    check_flag INTEGER NOT NULL DEFAULT 0,
    follow_up INTEGER NOT NULL DEFAULT 0,
    mention_count INTEGER NOT NULL DEFAULT 1,
    at_seconds INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (to_char(now(), 'YYYY-MM-DD HH24:MI:SS'))
);
CREATE INDEX IF NOT EXISTS idx_mentions_sermon ON scripture_mentions(sermon_id);
CREATE INDEX IF NOT EXISTS idx_mentions_user ON scripture_mentions(user_id);

-- Shared across everyone, regardless of who found the verse first - Bible text itself
-- isn't private to any one user, so this table intentionally has no user_id.
CREATE TABLE IF NOT EXISTS bible_cache (
    id SERIAL PRIMARY KEY,
    translation TEXT NOT NULL,
    book_nr INTEGER NOT NULL,
    chapter INTEGER NOT NULL,
    verses_json TEXT NOT NULL,
    fetched_at TEXT NOT NULL DEFAULT (to_char(now(), 'YYYY-MM-DD HH24:MI:SS')),
    UNIQUE(translation, book_nr, chapter)
);

CREATE TABLE IF NOT EXISTS settings (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (user_id, key)
);

-- One screen code per user - the only thing that lets a bare, logged-out /projector
-- screen watch that one person's live channel. See live.js and routes/screenCode.js.
CREATE TABLE IF NOT EXISTS screen_codes (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    code TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (to_char(now(), 'YYYY-MM-DD HH24:MI:SS'))
);

-- One row per user per calendar day - counts only, never the text itself, so an admin
-- can see usage without ever reading anyone's sermon. Also what the daily AI limit in
-- routes/ai.js checks against.
CREATE TABLE IF NOT EXISTS ai_usage (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    requests INTEGER NOT NULL DEFAULT 0,
    chars_in INTEGER NOT NULL DEFAULT 0,
    chars_out INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
);

-- Small global key/value store for admin-panel toggles that need to take effect
-- immediately, without a redeploy - currently just the AI on/off switch.
CREATE TABLE IF NOT EXISTS app_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
