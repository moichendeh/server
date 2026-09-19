# Sermon Scribe

A tool for writing down a sermon live, spotting Bible verses as they're said, and
projecting them on a screen. This document explains how the pieces fit together and
how to start, stop, back up and test the app. You do not need to be a programmer to
follow it - just type the commands exactly as shown, in a terminal, from this folder.

## How the pieces fit together

The app now has three parts, like most "real" web apps:

- **frontend/** - what you see in Chrome. This is the same detection/notes/projector
  code from before, just no longer saving to *this browser only*. It talks to the
  backend over the network to load and save everything.
- **backend/** - a small Node.js program (using Express) that the frontend talks to.
  It checks logins, and reads/writes the database. Nothing reaches the database
  except through this program.
- **the database** - one file, `backend/data/sermons.sqlite` (SQLite - a whole
  database that lives in a single file, so there is nothing extra to install or run).
  It stores every sermon, its paragraphs, which scriptures were mentioned where, a
  cache of downloaded Bible text, your settings, and the list of logins.

Picture it as: **Chrome (frontend) → talks to → the backend program → reads/writes →
the database file.** The frontend never touches the database directly, and the
database file never talks to the internet by itself.

## Starting the app

```
cd backend
npm install        (only needed the first time, or after pulling updates)
npm start
```

Then open **http://localhost:3000** in Chrome. The first account you create there
becomes the Admin.

To reach it from another device on the same Wi-Fi (like your phone), find this
computer's network address (see below) and open `http://<that address>:3000` instead.

## Stopping the app

Go to the terminal window where it's running and press `Ctrl+C`. Closing the terminal
window also stops it.

## Backing up the database

Everything lives in one file: `backend/data/sermons.sqlite`. To back it up, **stop the
app first** (so nothing is mid-write), then copy that one file somewhere safe (a USB
stick, a cloud drive folder, etc.). To restore a backup, stop the app, replace that
file with your saved copy, and start the app again.

## First-time setup (already done for you, but here's what it means)

`backend/.env` holds a secret key the backend uses to sign logins - it is never
committed to git and never sent to the browser. If you ever need to recreate it,
copy `backend/.env.example` to `backend/.env` and fill in a long random value for
`JWT_SECRET`.

## Roles

- **Admin** - full access, and can create accounts for teammates (Team card in the
  app once logged in).
- **Note-taker** - can write notes and project scripture, cannot manage accounts.
- **Media** - Stage A has nothing for this role to do yet; Stage B adds a
  projector-only page for it.

The very first account ever created on a fresh database becomes Admin automatically.
After that, anyone using "Create account" on the login screen becomes a Note-taker by
default - only a logged-in Admin can hand out the Admin or Media role, from the Team
card.

## Running the automated tests

```
cd backend
npm test
```

This runs a self-contained test suite (Node's built-in test runner) against a
throwaway database - it never touches your real data. It checks logins, roles,
saving/loading sermons, the conflict check for two people saving at once, settings,
and the "import old sermons" feature.

## Security notes

- Passwords are never stored as plain text - they are hashed with bcrypt before being
  saved.
- All API input is checked (email format, password length, valid roles, etc.) before
  it touches the database.
- Every database query uses parameter placeholders (never builds SQL out of raw
  text), which is what prevents SQL injection.
- No secret key or password is ever sent to the browser or written into
  `frontend/index.html`.
- Logins use a signed cookie plus a `sessions` row in the database, so "Log out"
  really ends that login (not just hides the cookie).

### What still needs to change before this goes on the open internet

Right now this is meant to run on your own network (or your own laptop). Before
putting it on the public internet, at minimum:

1. **HTTPS.** Right now it's plain HTTP. Logging in over plain HTTP on the open
   internet would send the password unencrypted. This needs a real domain name and a
   TLS certificate (free ones exist, e.g. via Let's Encrypt) in front of the backend.
2. **Real hosting.** `npm start` on a laptop is fine for testing, not for something
   that must stay online. It needs a proper host (a small cloud server, or a
   platform like Render/Fly.io/Railway) that keeps the process running and restarts
   it if it crashes.
3. **PostgreSQL instead of SQLite.** SQLite (one file) is great for one household/
   one small team on one machine, but struggles once many people use it over the
   network at once. The database code was written to plain, portable SQL on purpose
   so this move is mostly: create the same tables in Postgres, and change the
   database connection code - the rest of the app does not need to change.
4. **Rate limiting on login**, so a script trying thousands of passwords can't hammer
   the server.
5. A **real backup schedule** for the database (automatic, off-site), not just
   remembering to copy the file.

## Known limitations of Stage A (being upfront about the trade-offs made)

- If you close the browser tab within about half a second of your last keystroke, that
  very last bit of typing might not have reached the server yet. Everything before
  that is safe.
- If two people have the *same* sermon open on two devices and both save changes
  around the same moment, the second save is rejected with a message asking them to
  reload - it will never silently overwrite the other person's work, but they do have
  to reload and redo their edit.
- Logging in is via a cookie tied to one browser; there is no "remember me on this
  device forever" beyond the 30-day login length.
