const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const dataDir = path.join(__dirname, "../data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(path.join(dataDir, "ddns.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS workers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    subdomain TEXT UNIQUE NOT NULL,
    token TEXT UNIQUE NOT NULL,
    last_ip TEXT,
    cf_record_id TEXT,
    updated_at DATETIME,
    created_at DATETIME
  );
`);

// Migración suave: si la tabla existe de antes de añadir created_at, se agrega
// sin tocar los datos ya guardados. Segura de ejecutar en cada arranque.
const existingColumns = db.prepare("PRAGMA table_info(workers)").all().map((c) => c.name);
if (!existingColumns.includes("created_at")) {
  db.exec("ALTER TABLE workers ADD COLUMN created_at DATETIME");
}

module.exports = db;
