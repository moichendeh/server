-- PostgreSQL. Dates are stored as plain text in the exact same "YYYY-MM-DD HH:MM:SS"
-- shape the app has always used, so nothing that already reads/compares them needs to
-- change - only how the tables are created and how the value is generated (now()
-- instead of SQLite's datetime('now')).

CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'notetaker', 'media')),
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

CREATE TABLE IF NOT EXISTS sermons (
    id SERIAL PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    date TEXT NOT NULL DEFAULT '',
    elapsed INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (to_char(now(), 'YYYY-MM-DD HH24:MI:SS')),
    updated_at TEXT NOT NULL DEFAULT (to_char(now(), 'YYYY-MM-DD HH24:MI:SS'))
);

CREATE TABLE IF NOT EXISTS paragraphs (
    id SERIAL PRIMARY KEY,
    sermon_id INTEGER NOT NULL REFERENCES sermons(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    t INTEGER NOT NULL DEFAULT 0,
    lang TEXT NOT NULL DEFAULT 'en',
    speaker TEXT,
    text TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (to_char(now(), 'YYYY-MM-DD HH24:MI:SS'))
);
CREATE INDEX IF NOT EXISTS idx_paragraphs_sermon ON paragraphs(sermon_id, seq);

CREATE TABLE IF NOT EXISTS scripture_mentions (
    id SERIAL PRIMARY KEY,
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
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
