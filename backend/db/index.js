const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
    console.error('Missing DATABASE_URL. Copy backend/.env.example to backend/.env and fill it in.');
    process.exit(1);
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Managed Postgres hosts (Neon, Render, etc.) require SSL and hand out a
    // certificate chain the default Node trust store may not know - this still
    // encrypts the connection, it just skips verifying who signed the certificate.
    ssl: process.env.PGSSL === 'off' ? false : { rejectUnauthorized: false }
});

// The rest of the app writes plain SQL with "?" placeholders (like SQLite uses) -
// this turns "?" into Postgres's "$1, $2, ..." so nothing else has to change.
function toPg(sql) {
    let i = 0;
    return sql.replace(/\?/g, () => '$' + (++i));
}

// Wraps a query function (either the shared pool, or one checked-out client during a
// transaction) in the same db.prepare(sql).get/.all/.run(...params) shape the rest of
// the app already uses, so only "add await" was needed at each call site.
function wrap(query) {
    return {
        prepare(sql) {
            const pgSql = toPg(sql);
            return {
                async get(...params) { return (await query(pgSql, params)).rows[0]; },
                async all(...params) { return (await query(pgSql, params)).rows; },
                async run(...params) {
                    const r = await query(pgSql, params);
                    return { changes: r.rowCount, lastInsertRowid: r.rows[0] && r.rows[0].id };
                }
            };
        },
        async exec(sql) { await query(sql, []); }
    };
}

const db = wrap((sql, params) => pool.query(sql, params));

// Runs fn with a single checked-out connection so BEGIN/COMMIT/ROLLBACK actually wrap
// the queries inside it (a connection pool can otherwise hand different queries to
// different underlying connections, which would make transactions meaningless).
db.transaction = async (fn) => {
    const client = await pool.connect();
    const tx = wrap((sql, params) => client.query(sql, params));
    try {
        await client.query('BEGIN');
        const result = await fn(tx);
        await client.query('COMMIT');
        return result;
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
};

db.close = () => pool.end();

const migrate = fs.readFileSync(path.join(__dirname, 'migrate.sql'), 'utf8');
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.ready = pool.query(migrate).then(() => pool.query(schema))
    .catch(e => { console.error('Failed to set up database tables:', e.message); process.exit(1); });

module.exports = db;
