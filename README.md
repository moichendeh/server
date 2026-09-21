# Sermon Scribe

A tool for writing down a sermon live, spotting Bible verses as they're said, and
projecting them on a screen - now on any connected screen at once. This document
explains how the pieces fit together and how to start, stop, back up and test the
app. You do not need to be a programmer to follow it - just type the commands
exactly as shown, in a terminal, from this folder.

## How the pieces fit together

- **frontend/** - what you see in Chrome. The same detection/notes/projector code
  from Phase 1, talking to the backend over the network instead of saving to just
  this browser.
- **backend/** - a Node.js program (Express) that the frontend talks to over normal
  web requests, and a live "what's on the projector" channel (WebSocket) that keeps
  every open projector screen in sync the instant something is projected.
- **the database** - PostgreSQL. It stores every user's account, sermons, paragraphs,
  which scriptures were mentioned where, a cache of downloaded Bible text, settings,
  the list of logins, and who is currently logged in.

Picture it as: **Chrome (frontend) → talks to → the backend program → reads/writes →
the database.** The frontend never touches the database directly.

**This app is multi-tenant**: anyone can create their own account, and every person
only ever sees their own sermons, notes, settings, and projector link. The server
checks who is logged in on every single request and only ever reads or writes that
person's own rows - never anyone else's, even if someone tries to guess another
person's sermon id in the address bar.

For the live projector specifically: **any screen that opens `/projector` → connects
to → the backend's live channel.** Whoever projects a verse (from the notes page, or
by clicking Next/Previous/Clear directly on a projector screen) sends it once to the
backend, which relays it to every other connected screen so they all update together.

## Setting up PostgreSQL (only needed once)

This app needs a PostgreSQL database to talk to. Two options:

- **For your own testing on this machine**: install PostgreSQL locally (Windows:
  `winget install --id PostgreSQL.PostgreSQL.17 -e`), then create a database for the
  app to use with `psql`, e.g. a database named `sermon_scribe`.
- **For the real, always-on version reachable off this laptop**: use a free hosted
  Postgres (e.g. [Neon](https://neon.tech) or [Supabase](https://supabase.com)) - no
  local install needed, and it keeps running even when your laptop is off. You will
  need to create an account with whichever one you choose (ask me and I'll walk you
  through it step by step).

Either way, you'll end up with a **connection string** that looks like
`postgresql://user:password@host:5432/dbname` (a hosted one will usually end in
`?sslmode=require`). Put it in `backend/.env` as `DATABASE_URL` (see below).

## Starting the app

```
cd backend
npm install        (only needed the first time, or after pulling updates)
npm start
```

Then open **http://localhost:3000** in Chrome and create an account (name, email,
10+ character password). Anyone can sign up - see **Accounts and the Admin page**
below for how someone becomes an Admin.

To reach it from another device on the same Wi-Fi (like your phone), find this
computer's network address and open `http://<that address>:3000` instead.

## Stopping the app

Go to the terminal window where it's running and press `Ctrl+C`. Closing the terminal
window also stops it.

## Backing up the database

With Postgres, back up with `pg_dump` (comes with the PostgreSQL install), e.g.:

```
pg_dump "your DATABASE_URL here" > backup.sql
```

To restore: create a fresh database, then `psql "your DATABASE_URL here" < backup.sql`.
If you're using a hosted provider (Neon/Supabase), they also keep their own automatic
backups - check their dashboard.

## First-time setup (already done for you on this machine, but here's what it means)

`backend/.env` (never committed to git, never sent to the browser) holds:

- `JWT_SECRET` - a long random string used to sign logins. Changing it logs everyone out.
- `DATABASE_URL` - your PostgreSQL connection string (see above).
- `PGSSL=off` - only needed for a **local** Postgres install, which doesn't speak
  encrypted connections by default. Leave this line out entirely for a hosted
  database (Neon/Supabase) - those require encryption, which is the normal setting.
- `ADMIN_EMAILS` - a comma-separated list of email addresses that should be Admins,
  e.g. `pastor@example.com,office@example.com`. See below.
- `API_BIBLE_KEY` - optional, see **Bible translations** below.
- `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `AI_ENABLED`, `AI_DAILY_CHAR_LIMIT`,
  `AI_DAILY_REQUEST_LIMIT` - optional, see **AI correction and translation** below.

If you ever need to recreate `.env`, copy `backend/.env.example` to `backend/.env`
and fill in your own values.

## Bible translations

King James (KJV), World English Bible (WEB), American Standard (ASV) and the two
German Elberfelder editions are fetched straight from the browser, from free public
Bible APIs - no setup needed.

NIV, AMP and CSB come from [api.bible](https://scripture.api.bible) instead, since
those translations are licensed rather than public domain. Because that requires an
API key tied to your account's quota, those three are fetched by the **backend**, not
the browser - the frontend calls `GET /api/bible/:translation/:bookNr/:chapter` on our
own server, which forwards the request to api.bible using `API_BIBLE_KEY` and caches
the result (in the `bible_cache` table, shared across everyone, since Bible text is
the same for everyone) so the same chapter is only ever fetched from api.bible once.
If `API_BIBLE_KEY` isn't set, or your api.bible account hasn't been granted one of
these translations, that translation just reports "not available" rather than
breaking anything else.

## AI correction and translation

Turned on per-user, in **My account → "Use AI correction and translation"** (off by
default). When it's on:

- **Correction.** Once a paragraph is finished (a pause, or the next paragraph
  starting - never a word while it's still being recognized), it's sent once to
  Claude to fix spelling, grammar, punctuation and misheard Bible book names/numbers.
  The **original text is never changed** - the correction is stored alongside it, and
  a small **Original / Corrected** switch appears on that paragraph once it arrives.
  Editing a paragraph by hand at any point - in either view - is never later
  overwritten by a slower AI reply for that same paragraph.
- **Translation.** The "Translate to" setting in the toolbar (None/English/German/
  Krio) translates each finished paragraph and shows it in smaller text underneath.
  Works in every direction the languages allow (German ↔ English, and any spoken/typed
  language ↔ Krio) - a translation into or out of **Krio or Twi is always labelled
  "draft translation, please review"**, since Claude is noticeably less reliable in
  those two.
- **Krio** is a fourth language button next to English/Deutsch/Twi. Like Twi, there is
  no live transcription for it (browsers can't do that) - it's typed/pasted notes only.
- **Bible verses on the projector are unaffected** - they still come from the Bible
  translation sources (see above), never from the AI.
- **Downloads.** The Export card has a "Text to include" choice: Original, Corrected,
  Original + Corrected, Translation only, Original + Translation, or side by side.

Everything above requires being logged in, and needs a couple of things set on the
server (see below) - if the AI is off, unconfigured, or a request fails for any
reason, the app keeps working exactly as before with the plain original text; nothing
about note-taking, scripture detection, or projecting is ever blocked by this feature.

### Cost and abuse protection

- Requests only ever come from the backend - the browser never talks to Anthropic
  directly, and never sees the API key.
- One Claude call handles both correction and translation together when both are
  needed, instead of two - it's cheaper and it's the only way this feature is built.
- Two independent daily caps per user, both configurable by environment variable:
  `AI_DAILY_CHAR_LIMIT` (default 150,000 characters/day) and
  `AI_DAILY_REQUEST_LIMIT` (default 1,000 requests/day). Hitting either one returns a
  clear "You reached today's limit. The rest of your notes are still saved." message
  - text keeps saving normally, it just stops being corrected/translated until the
  next day.
- Rate limiting (20 requests/minute per logged-in user) on top of the daily caps, to
  stop a runaway loop rather than a real person.
- Usage (request and character **counts only, never the text**) is logged per user
  per day in the database and shown on the Admin page, next to each person's sermon
  count.
- Two independent off-switches: the `AI_ENABLED` environment variable (site-wide,
  needs a redeploy to change) and a button on the Admin page (takes effect
  immediately for everyone, no redeploy - this is the "turn it off right now" switch).
  Both need `ANTHROPIC_API_KEY` to be set in the first place.

## Accounts and the Admin page

Anyone can create their own account (name, email, a 10+ character password, and
ticking a box to accept the [privacy notice](frontend/privacy.html)). There are only
two roles:

- **user** - the normal role. Everyone gets this by default. A user can only ever see
  and manage their own sermons, settings, and projector code.
- **admin** - can additionally open **`/admin`** in the app (a link appears in the
  header once logged in), which lists everyone who has ever signed up: name, email,
  sign-up date, last login, how many times they've logged in, how many sermons they
  have (a **count only** - an Admin can never read anyone's sermon text), and whether
  the account is enabled or disabled. From there an Admin can search, sort, download
  the list as a CSV file, disable/enable an account (a disabled account is instantly
  logged out and can't log back in), or permanently delete an account and everything
  in it (with a confirmation, since this cannot be undone).

**Who becomes an Admin is controlled entirely by you**, through the `ADMIN_EMAILS`
environment variable - never by "whoever signs up first". Any email address listed
there becomes (or stays) an Admin the moment that person registers or logs in; every
other address stays a normal user. To change who's an Admin, edit `ADMIN_EMAILS` and
have that person log out and back in (or just wait for their next login).

If you had sermons in the database from before accounts existed, they aren't deleted -
they're simply invisible to everyone until an Admin (per `ADMIN_EMAILS`) logs in for
the first time, at which point that old data is automatically handed to them.

### Seeing the same user list directly in Neon

If you'd rather look at the Neon dashboard than open `/admin`, paste this into the
Neon SQL Editor:

```sql
SELECT u.name, u.email, u.role, u.created_at AS signed_up,
       u.last_login_at, u.login_count, u.is_disabled,
       COUNT(s.id) AS sermon_count
FROM users u
LEFT JOIN sermons s ON s.user_id = u.id
GROUP BY u.id
ORDER BY u.created_at DESC;
```

## Using the live projector (Stage B)

Each account has its **own** projector - what one person projects is only ever seen on
their own projector link, never on anyone else's, even if two people happen to be
using the app at the same time.

`/projector` needs **no login at all** - it opens straight to whatever is currently
projected on the one account it belongs to (or a plain "Waiting for the projector
link" screen if nothing has been shared with it yet). What it's allowed to *do*
depends on how it got there:

- **Sharing it with the media team**: on the notes page, under "Projector settings",
  there's a **projector link** with a **Copy link** button. Share that link (not the
  bare `/projector` URL) with whoever is running the second screen - it contains a
  "screen code" that lets that device watch the live feed. It is view-only: that
  device can never read or change sermons, notes, or anything else, even if someone
  opens the browser's developer tools and tries - the server itself refuses any
  control message from a code-only connection, this isn't just a hidden button.
  Clicking **"New link"** immediately invalidates the old one (anyone still on it
  stops receiving updates) - use this if a link was shared too widely or a device is
  no longer needed.
- **Opening it on your own logged-in browser** (e.g. "Open projector window") - the
  same page, but because it's logged in, it also gets Next/Previous/Clear buttons to
  control what's projected, kept in sync with every other connected screen (the notes
  page's "On the screen now" panel included).
- A small pill in the corner says **Connected**, or **Disconnected - retrying...** if
  the network drops - it reconnects on its own once the network is back, no need to
  reload the page.
- Either kind of `/projector` screen can page through whatever pages it was already
  sent (if it's allowed to control anything at all - see above), but can't pull up a
  *different* verse on its own - that part still needs the notes page, since that's
  what knows how to look up Bible text.

## Running the automated tests

```
cd backend
npm test
```

Runs six self-contained test suites (Node's built-in test runner), each against its
own throwaway database - never your real data:

- **test/api.test.js** - registration/login rules, admin-by-`ADMIN_EMAILS`, password
  hashing, CSRF protection, login tracking, disabling an account, saving/loading
  sermons, the conflict check for two people saving at once, settings, and "import old
  sermons".
- **test/isolation.test.js** - the core promise of this update, proven with two real
  accounts: person B can never list, open, edit, delete, or download person A's
  sermons - not even by guessing ids, negative numbers, or SQL-injection-style ids -
  always getting a plain 404, and settings/screen-codes are separate per person too.
- **test/admin.test.js** - only Admins can reach `/api/admin`, the list never contains
  sermon content, search works, and disable/enable/delete behave correctly (including
  that an Admin can't disable or delete themselves through it).
- **test/privacy.test.js** - registration requires accepting the privacy notice,
  "Download my data" returns your own data only, and "Delete my account" really
  removes everything and logs you out.
- **test/live.test.js** - the live projector channel, now per-user: logged-in devices
  or a valid screen code can connect, projecting reaches every other connection in
  *that same person's* room and never a different person's room, a screen that joins
  late still sees whatever is currently live, paging Next/Previous/Clear keeps
  everyone in sync, a code-only connection can watch but its own control messages are
  silently ignored by the server (not just hidden in the UI), a stale/invalid code is
  rejected, and creating a new code revokes the old one.
- **test/rateLimit.test.js** - proves repeated login attempts really do get blocked
  (429) after enough tries.
- **test/bible.test.js** - the api.bible-backed translations: requires login, rejects
  an unknown translation or an invalid book/chapter, parses a real api.bible chapter
  response into the same `{v, t}` shape the frontend expects, serves a repeat request
  from `bible_cache` instead of calling api.bible again, and reports a translation
  this account has no api.bible access to as unavailable rather than crashing. Runs
  against a fake api.bible (no real key or network call needed).
- **test/ai.test.js** - the AI correction/translation endpoint: requires login,
  correcting sample English/German/Krio text, translating German↔English (not
  flagged as a draft) and English→Krio (always flagged as a draft), a garbled AI
  reply degrading to "nothing changed" rather than crashing, a failed Anthropic
  request being reported cleanly, the daily character limit blocking further
  requests with the "still saved" message, and the admin on/off switch taking effect
  immediately. Runs against a fake Claude API (no real key, no network call, no cost).

By default these run against local Postgres databases named `sermon_scribe_test`,
`sermon_scribe_test_isolation`, `sermon_scribe_test_admin`, `sermon_scribe_test_privacy`,
`sermon_scribe_test_live`, `sermon_scribe_test_ratelimit`, `sermon_scribe_test_bible`,
and `sermon_scribe_test_ai`. Point any of them elsewhere with `DATABASE_URL_TEST`,
`DATABASE_URL_TEST_ISOLATION`, `DATABASE_URL_TEST_ADMIN`, `DATABASE_URL_TEST_PRIVACY`,
`DATABASE_URL_TEST_LIVE`, `DATABASE_URL_TEST_RATELIMIT`, `DATABASE_URL_TEST_BIBLE`, or
`DATABASE_URL_TEST_AI`.

## Security notes

- Passwords are never stored as plain text - they are hashed with bcrypt before being saved.
- Every table holding a person's data (sermons, paragraphs, scripture mentions,
  settings, screen codes) has a `user_id`, and every single query filters by the
  logged-in person's own id - the server never trusts an id sent by the browser.
- All API input is checked (name, email format, password length, privacy acceptance,
  etc.) before it touches the database.
- Every database query uses parameter placeholders (never builds SQL out of raw
  text), which is what prevents SQL injection.
- Login attempts are rate-limited, so a script trying many passwords in a row gets
  blocked (429) after a handful of tries.
- Cross-site request forgery (CSRF) is blocked: a request that changes anything is
  only accepted if it came from this app's own page, not from some other website
  tricking your browser into submitting it.
- No secret key or password is ever sent to the browser or written into `frontend/index.html`.
- Logins use a signed, `httpOnly`/`secure`/`sameSite` cookie plus a `sessions` row in
  the database, so "Log out" (or an Admin disabling an account) really ends that
  login immediately - not just hides the cookie.
- The live projector channel (`/ws`) requires either the same login cookie as
  everything else, or a valid per-person screen code - and a screen-code-only
  connection can only ever *watch*, never control anything, even if someone opens
  developer tools and sends control messages directly; the server itself refuses them.

### What still needs to change before this goes on the open internet

1. **HTTPS.** A real hosting platform (Render, see below) provides this automatically -
   just make sure you're using the `https://` address it gives you, not `http://`.
2. A **backup schedule** for the database that runs on its own, not just remembering
   to run `pg_dump`. Neon keeps its own automatic backups too - check its dashboard.

## Deploying to Render (with a Neon database)

`render.yaml` at the top of this repository describes the whole backend as a Render
"Blueprint". In the Render dashboard, choose **New → Blueprint** and point it at this
repository; Render reads `render.yaml` and sets most things up automatically. You will
be asked to fill in three values by hand (they're deliberately left blank in the file
so they're never committed to git):

- `JWT_SECRET` - any long random string (e.g. generate one with a password manager).
- `DATABASE_URL` - the connection string from your Neon project (Neon dashboard →
  Connection Details). It should end in `?sslmode=require`.
- `ADMIN_EMAILS` - the email address(es) that should be Admins, comma-separated, e.g.
  `pastor@example.com,office@example.com`. See **Accounts and the Admin page** above.
- `API_BIBLE_KEY` - optional. Your API key from [scripture.api.bible](https://scripture.api.bible),
  needed only for the NIV, AMP and CSB translations (see **Bible translations** below).
  Leave it blank and those three translations simply show as unavailable - everything
  else works without it.
- `ANTHROPIC_API_KEY` - optional. Your API key from [console.anthropic.com](https://console.anthropic.com),
  needed only for AI correction/translation (see **AI correction and translation**
  above). Leave it blank and those features just report as turned off.

`ANTHROPIC_MODEL`, `AI_ENABLED`, `AI_DAILY_CHAR_LIMIT` and `AI_DAILY_REQUEST_LIMIT` are
also in `render.yaml`, already filled in with working defaults - you only need to touch
them if you want to change the model or the daily caps.

`NODE_ENV=production` is already set for you in `render.yaml` - this is what turns on
`secure` cookies (HTTPS-only), which only works correctly once the app is actually
served over HTTPS, which Render does automatically.

## Known limitations (being upfront about the trade-offs made)

- If you close the browser tab within about half a second of your last keystroke, that
  very last bit of typing might not have reached the server yet. Everything before
  that is safe.
- If two people have the *same* sermon open on two devices and both save changes
  around the same moment, the second save is rejected with a message asking them to
  reload - it will never silently overwrite the other person's work, but they do have
  to reload and redo their edit.
- A `/projector`-only screen (no notes page open anywhere) can page through verses it
  already has, but can't fetch a brand new one on its own.
- Logging in is via a cookie tied to one browser; there is no "remember me on this
  device forever" beyond the 30-day login length.
- Upgrading a database that already had sermons in it from before accounts existed
  drops the old, single shared "settings" row (it only ever held small display
  preferences, never sermon content) so it can be recreated per-person. Your sermons
  themselves are never touched, and are handed to the Admin account automatically -
  see **Accounts and the Admin page**.
- Everyone's own settings, projector code, and login history stay private to them; an
  Admin can see *that* someone has an account and how many sermons they have, but
  never the sermon content itself.
