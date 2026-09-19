-- Plain SQL, deliberately avoiding SQLite-only tricks, so this reads the same way
-- once the app moves to PostgreSQL later.

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'notetaker', 'media')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per logged-in device/browser. A login's cookie only works while its row is
-- here; logging out deletes the row, so the cookie stops working immediately (a plain
-- login token on its own can't be "un-issued", so this is what makes logout real).
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sermons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL DEFAULT '',
    date TEXT NOT NULL DEFAULT '',
    elapsed INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS paragraphs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sermon_id INTEGER NOT NULL REFERENCES sermons(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    t INTEGER NOT NULL DEFAULT 0,
    lang TEXT NOT NULL DEFAULT 'en',
    speaker TEXT,
    text TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_paragraphs_sermon ON paragraphs(sermon_id, seq);

CREATE TABLE IF NOT EXISTS scripture_mentions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
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
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mentions_sermon ON scripture_mentions(sermon_id);

CREATE TABLE IF NOT EXISTS bible_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    translation TEXT NOT NULL,
    book_nr INTEGER NOT NULL,
    chapter INTEGER NOT NULL,
    verses_json TEXT NOT NULL,
    fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(translation, book_nr, chapter)
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
