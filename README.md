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
- **the database** - PostgreSQL. It stores every sermon, its paragraphs, which
  scriptures were mentioned where, a cache of downloaded Bible text, your settings,
  the list of logins, and who is currently logged in.

Picture it as: **Chrome (frontend) → talks to → the backend program → reads/writes →
the database.** The frontend never touches the database directly.

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

Then open **http://localhost:3000** in Chrome. The first account you create there
becomes the Admin.

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

If you ever need to recreate `.env`, copy `backend/.env.example` to `backend/.env`
and fill in your own values.

## Roles

- **Admin** - full access, and can create accounts for teammates (Team card in the app).
- **Note-taker** - can write notes and project scripture, cannot manage accounts.
- **Media** - only ever sees the `/projector` page, never the sermon notes. Logging in
  takes them straight to a screen with just an "Open the projector page" button.

The very first account ever created on a fresh database becomes Admin automatically.
After that, anyone using "Create account" on the login screen becomes a Note-taker by
default - only a logged-in Admin can hand out the Admin or Media role, from the Team card.

## Using the live projector (Stage B)

`/projector` needs **no login at all** - it opens straight to whatever is currently
projected (or a plain "Waiting for the projector link" screen if nothing has been
shared with it yet). What it's allowed to *do* depends on how it got there:

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
- **Opening it on your own logged-in browser** (e.g. "Open projector window", or a
  Media-role account) - the same page, but because it's logged in, it also gets
  Next/Previous/Clear buttons to control what's projected, kept in sync with every
  other connected screen (the notes page's "On the screen now" panel included).
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

Runs two self-contained test suites (Node's built-in test runner) against a throwaway
database - never your real data:

- **test/api.test.js** - logins, roles, saving/loading sermons, the conflict check for
  two people saving at once, settings, and the "import old sermons" feature.
- **test/live.test.js** - the live projector channel: logged-in devices or a valid
  screen code can connect, projecting reaches every other connected screen, a screen
  that joins late still sees whatever is currently live, paging Next/Previous/Clear
  keeps everyone in sync, going past the last page is refused, a code-only connection
  can watch but its own control messages are silently ignored by the server (not just
  hidden in the UI), a stale/invalid code is rejected, and creating a new code revokes
  the old one.

By default these run against `sermon_scribe_test` / `sermon_scribe_test_live` on a
local Postgres. Point them elsewhere with `DATABASE_URL_TEST` / `DATABASE_URL_TEST_LIVE`.

## Security notes

- Passwords are never stored as plain text - they are hashed with bcrypt before being saved.
- All API input is checked (email format, password length, valid roles, etc.) before
  it touches the database.
- Every database query uses parameter placeholders (never builds SQL out of raw
  text), which is what prevents SQL injection.
- No secret key or password is ever sent to the browser or written into `frontend/index.html`.
- Logins use a signed cookie plus a `sessions` row in the database, so "Log out"
  really ends that login (not just hides the cookie).
- The live projector channel (`/ws`) requires the same login cookie as everything
  else - a stranger can't connect to it just by guessing the URL.

### What still needs to change before this goes on the open internet

1. **HTTPS.** Right now it's plain HTTP. Logging in over plain HTTP on the open
   internet would send the password unencrypted. A real hosting platform (see below)
   normally provides this for you automatically.
2. **Real hosting**, so the app stays online without your laptop running - a platform
   like Render, Fly.io or Railway. This also solves HTTPS in most cases.
3. **Rate limiting on login**, so a script trying thousands of passwords can't hammer
   the server.
4. A **backup schedule** for the database that runs on its own, not just remembering
   to run `pg_dump`.

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
