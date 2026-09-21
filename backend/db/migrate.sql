-- Upgrades a database created by the OLD single-church version of this app (Stage A/B
-- and the screen-code branch) to the new multi-tenant shape. Every step here is safe
-- to run again on an already-migrated database (checks first, does nothing if there's
-- nothing to do) - this runs automatically every time the server starts.
--
-- Data safety: nothing that already exists is ever deleted here except the old
-- single shared "settings" table, which only ever held small app preferences
-- (language, translation choice, etc.) for the one church that used to share this
-- app - never anyone's sermon text. Sermons, paragraphs and scripture mentions are
-- only ever added to, renamed, or backfilled - never dropped.

-- ---------------------------------------------------------------------------
-- users: new columns, old roles remapped, admin status will be re-derived from
-- ADMIN_EMAILS the next time that person logs in (see routes/auth.js), never stored
-- as a fixed fact here.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'users') THEN
        ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT '';
        ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TEXT;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS login_count INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS is_disabled BOOLEAN NOT NULL DEFAULT false;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS privacy_accepted_at TEXT;

        ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
        UPDATE users SET role = 'user' WHERE role NOT IN ('user', 'admin');
        UPDATE users SET email = lower(email) WHERE email <> lower(email);
        ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('user', 'admin'));
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- sermons: the old "created_by" column becomes "user_id" - same meaning, new name to
-- match every other table. Left nullable on purpose: a sermon with no owner yet is
-- invisible to everyone (every query filters "WHERE user_id = <you>", and nothing
-- equals NULL) until an admin logs in and claims it - see routes/auth.js.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'sermons' AND column_name = 'created_by') THEN
        ALTER TABLE sermons RENAME COLUMN created_by TO user_id;
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- paragraphs / scripture_mentions: add their own user_id (rather than only ever
-- reaching it through a join on sermons) and fill it in from the sermon they belong
-- to, for any row that does not have one yet.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'paragraphs') THEN
        ALTER TABLE paragraphs ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id);
        UPDATE paragraphs p SET user_id = s.user_id FROM sermons s WHERE p.sermon_id = s.id AND p.user_id IS NULL;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'scripture_mentions') THEN
        ALTER TABLE scripture_mentions ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id);
        UPDATE scripture_mentions m SET user_id = s.user_id FROM sermons s WHERE m.sermon_id = s.id AND m.user_id IS NULL;
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- paragraphs: AI correction/translation columns, added for the AI text features.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'paragraphs') THEN
        ALTER TABLE paragraphs ADD COLUMN IF NOT EXISTS corrected_text TEXT;
        ALTER TABLE paragraphs ADD COLUMN IF NOT EXISTS translated_text TEXT;
        ALTER TABLE paragraphs ADD COLUMN IF NOT EXISTS translated_lang TEXT;
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- settings: the old table was one shared row per key for the whole (single) church.
-- That shape cannot become per-user (a primary key can't have a NULL column), and the
-- values in it were only ever small display preferences, never sermon content - so
-- the safe move is to drop just this one table and let it be recreated fresh, per
-- user, by schema.sql right after this file runs. Each user simply gets the app's
-- normal defaults the first time they open it, same as any brand new user would.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'settings' AND column_name = 'user_id'
    ) THEN
        NULL; -- already migrated, nothing to do
    ELSIF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'settings') THEN
        DROP TABLE settings;
    END IF;
END $$;
