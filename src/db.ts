import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";

// ETHOS_DB=:memory: é usado nos testes.
const dbPath = process.env.ETHOS_DB ?? path.join(process.cwd(), "data", "ethos.db");
if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);

export const ROLES = ["admin", "colaborador", "proprietario", "inquilino"] as const;
export type Role = (typeof ROLES)[number];

db.exec(`
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS organizations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Um usuário pode ter vínculos e papéis diferentes em organizações diferentes.
  CREATE TABLE IF NOT EXISTS organization_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('admin','colaborador','proprietario','inquilino')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (organization_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS owners (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    document TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (organization_id, document)
  );

  CREATE TABLE IF NOT EXISTS properties (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('casa','apartamento','terreno','comercial','outro')),
    street TEXT, number TEXT, complement TEXT, neighborhood TEXT,
    city TEXT, state TEXT, zip TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Um imóvel pode ter mais de um proprietário.
  CREATE TABLE IF NOT EXISTS property_owners (
    property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
    PRIMARY KEY (property_id, owner_id)
  );

  -- Unidade locável: um imóvel pode ter várias (ex.: terreno com dez casas).
  CREATE TABLE IF NOT EXISTS units (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    identifier TEXT NOT NULL,
    area_m2 INTEGER,
    bedrooms INTEGER,
    rent_reference_cents INTEGER,
    status TEXT NOT NULL DEFAULT 'disponivel' CHECK (status IN ('disponivel','ocupada','manutencao')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (property_id, identifier)
  );

  CREATE TABLE IF NOT EXISTS tenants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    document TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (organization_id, document)
  );
`);

/** Executa fn dentro de uma transação; faz rollback se lançar. */
export function transaction<T>(fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export interface User {
  id: number;
  name: string;
  email: string;
}

export interface AuthContext {
  user: User;
  organization: { id: number; name: string };
  role: Role;
}
