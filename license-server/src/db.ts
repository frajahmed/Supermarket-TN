/**
 * Datenhaltung des Lizenzservers (SQLite, in Node eingebaut).
 * Enthält ausschließlich Vertrags- und Gerätedaten – keine Geschäftsdaten der Kunden.
 */
import { DatabaseSync } from 'node:sqlite';

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS admins (
      id            TEXT PRIMARY KEY,
      email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    ) STRICT;

    CREATE TABLE IF NOT EXISTS admin_sessions (
      token_hash TEXT PRIMARY KEY,
      admin_id   TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    ) STRICT;

    -- Ein Lizenznehmer = ein Kunde = eine Installation (ein Kundenserver)
    CREATE TABLE IF NOT EXISTS licensees (
      id                  TEXT PRIMARY KEY,          -- Installations-ID
      name                TEXT NOT NULL,
      tax_id              TEXT,                      -- Matricule fiscal
      contact             TEXT,
      plan                TEXT NOT NULL DEFAULT 'standard',
      max_devices         INTEGER NOT NULL CHECK (max_devices > 0),
      paid_until          TEXT NOT NULL,             -- YYYY-MM-DD
      status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
      install_secret_hash TEXT NOT NULL,             -- SHA-256 des Installations-Secrets
      last_check_at       INTEGER,
      created_at          TEXT NOT NULL DEFAULT (datetime('now'))
    ) STRICT;

    CREATE TABLE IF NOT EXISTS devices (
      id              TEXT PRIMARY KEY,
      licensee_id     TEXT NOT NULL REFERENCES licensees(id),
      name            TEXT NOT NULL,
      kind            TEXT NOT NULL,
      public_key      TEXT NOT NULL UNIQUE,          -- Ed25519, SPKI DER base64
      activation_code TEXT NOT NULL,                 -- wird am Gerät angezeigt, zum Abgleich am Telefon
      status          TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'approved', 'rejected', 'revoked')),
      certificate     TEXT,
      requested_at    INTEGER NOT NULL,
      requested_ip    TEXT,
      decided_at      INTEGER,
      decided_by      TEXT REFERENCES admins(id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS devices_by_licensee ON devices (licensee_id, status);

    CREATE TABLE IF NOT EXISTS audit_log (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      at     INTEGER NOT NULL,
      actor  TEXT NOT NULL,                          -- admin:<id> | installation:<id> | device:<id>
      action TEXT NOT NULL,
      detail TEXT
    ) STRICT;
  `);
  return db;
}
