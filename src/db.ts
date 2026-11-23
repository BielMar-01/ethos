import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { PGlite } from "@electric-sql/pglite";

// Carrega .env se existir (Node 20+). Variáveis já definidas no ambiente prevalecem.
try {
  process.loadEnvFile(path.join(process.cwd(), ".env"));
} catch {
  /* sem .env: usa o ambiente */
}

export const ROLES = ["admin", "colaborador", "proprietario", "inquilino"] as const;
export type Role = (typeof ROLES)[number];

export interface User {
  id: number;
  name: string;
  email: string;
}

export interface AuthContext {
  user: User;
  organization: { id: number; name: string };
  role: Role;
  /** Cadastro de inquilino/proprietário ao qual este acesso está vinculado (área do cliente). */
  tenantId: number | null;
  ownerId: number | null;
  /** Autenticado por chave de API (somente leitura). */
  viaApiKey?: boolean;
}

/** Interface mínima comum ao pool (produção) e ao PGlite (testes). */
export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Executa um script com vários comandos, sem parâmetros (migrações). */
  exec(sql: string): Promise<void>;
}

// ETHOS_DB=memory usa um Postgres em memória (PGlite) — apenas para testes.
const useMemory = process.env.ETHOS_DB === "memory";

let pool: pg.Pool | undefined;
let lite: PGlite | undefined;

// Colunas `date` (OID 1082) como texto "AAAA-MM-DD": evita deslocamento de fuso horário.
const DATE_OID = 1082;

if (useMemory) {
  lite = new PGlite({ parsers: { [DATE_OID]: (v: string) => v } });
} else {
  pg.types.setTypeParser(DATE_OID, (v: string) => v);
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL não definida (veja .env.example).");
  }
  pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, // Supabase exige TLS
    max: 10,
  });
}

export const db: Queryable = {
  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    if (lite) return (await lite.query<T>(sql, params)).rows;
    return (await pool!.query(sql, params)).rows as T[];
  },
  async exec(sql: string): Promise<void> {
    if (lite) await lite.exec(sql);
    else await pool!.query(sql);
  },
};

/** Executa fn em uma transação; faz rollback se lançar. */
export async function transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
  if (lite) {
    return lite.transaction((tx) =>
      fn({
        query: async (sql, params = []) => (await tx.query(sql, params)).rows as never,
        exec: async (sql) => void (await tx.exec(sql)),
      }),
    );
  }
  const client = await pool!.connect();
  try {
    await client.query("BEGIN");
    const result = await fn({
      query: async (sql, params = []) => (await client.query(sql, params)).rows as never,
      exec: async (sql) => void (await client.query(sql)),
    });
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Aplica, em ordem, os arquivos migrations/*.sql ainda não registrados. */
export async function migrate(): Promise<string[]> {
  await db.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  if (!useMemory) await db.query("ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY");
  const dir = path.join(process.cwd(), "migrations");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const applied = new Set((await db.query<{ name: string }>("SELECT name FROM schema_migrations")).map((r) => r.name));
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    await transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
    });
    ran.push(file);
  }
  return ran;
}

export async function closeDb(): Promise<void> {
  await pool?.end();
  await lite?.close();
}

const sqlState = (err: unknown): string | undefined =>
  typeof err === "object" && err !== null ? (err as { code?: string }).code : undefined;

/** SQLSTATE 23505 = violação de UNIQUE. */
export const isUniqueViolation = (err: unknown): boolean => sqlState(err) === "23505";

/** SQLSTATE 23503 (chave estrangeira) ou 23001 (ON DELETE RESTRICT): registro em uso. */
export const isForeignKeyViolation = (err: unknown): boolean => ["23503", "23001"].includes(sqlState(err) ?? "");
