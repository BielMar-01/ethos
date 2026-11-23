import { Router } from "express";
import { db } from "./db.js";
import { requireAuth, requireRole } from "./auth.js";

export type Field = {
  name: string;
  required?: boolean;
  max?: number;
} & (
  | { kind: "string"; email?: boolean }
  | { kind: "int"; min?: number }
  | { kind: "enum"; values: readonly string[] }
  /** Chave estrangeira: o registro referenciado precisa ser da mesma organização. */
  | { kind: "ref"; table: string }
);

type Value = string | number | null;
type Result = { values: Record<string, Value> } | { error: string };

export function validate(
  body: Record<string, unknown>,
  fields: Field[],
  organizationId: number,
  partial: boolean,
): Result {
  const values: Record<string, Value> = {};
  for (const f of fields) {
    const v = body[f.name];
    if (v === undefined) {
      if (!partial && f.required) return { error: `Campo obrigatório: ${f.name}` };
      continue;
    }
    if (v === null || v === "") {
      if (f.required) return { error: `Campo obrigatório: ${f.name}` };
      values[f.name] = null;
      continue;
    }
    switch (f.kind) {
      case "string": {
        if (typeof v !== "string") return { error: `Valor inválido: ${f.name}` };
        const s = v.trim();
        if (s.length > (f.max ?? 200)) return { error: `Valor muito longo: ${f.name}` };
        if (f.email && !/^\S+@\S+\.\S+$/.test(s)) return { error: `E-mail inválido: ${f.name}` };
        values[f.name] = s;
        break;
      }
      case "int": {
        if (typeof v !== "number" || !Number.isInteger(v) || v < (f.min ?? 0)) {
          return { error: `Número inválido: ${f.name}` };
        }
        values[f.name] = v;
        break;
      }
      case "enum": {
        if (typeof v !== "string" || !f.values.includes(v)) return { error: `Valor inválido: ${f.name}` };
        values[f.name] = v;
        break;
      }
      case "ref": {
        if (typeof v !== "number" || !Number.isInteger(v)) return { error: `Referência inválida: ${f.name}` };
        const found = db
          .prepare(`SELECT 1 FROM ${f.table} WHERE id = ? AND organization_id = ?`)
          .get(v, organizationId);
        if (!found) return { error: `Referência inexistente: ${f.name}` };
        values[f.name] = v;
        break;
      }
    }
  }
  return { values };
}

export interface CrudOptions {
  table: string;
  fields: Field[];
  orderBy?: string;
}

/**
 * CRUD genérico escopado por organização. Nomes de tabela e coluna vêm apenas
 * da configuração no código (nunca do cliente); valores sempre via parâmetros.
 */
export function crudRouter({ table, fields, orderBy = "id" }: CrudOptions): Router {
  const router = Router();
  const staff = requireRole("admin", "colaborador");
  router.use(requireAuth, staff);

  router.get("/", (req, res) => {
    const rows = db
      .prepare(`SELECT * FROM ${table} WHERE organization_id = ? ORDER BY ${orderBy}`)
      .all(req.auth!.organization.id);
    res.json({ items: rows });
  });

  router.get("/:id", (req, res) => {
    const row = db
      .prepare(`SELECT * FROM ${table} WHERE id = ? AND organization_id = ?`)
      .get(Number(req.params.id), req.auth!.organization.id);
    if (!row) {
      res.status(404).json({ error: "Não encontrado" });
      return;
    }
    res.json({ item: row });
  });

  router.post("/", (req, res) => {
    const orgId = req.auth!.organization.id;
    const result = validate(req.body ?? {}, fields, orgId, false);
    if ("error" in result) {
      res.status(400).json({ error: result.error });
      return;
    }
    const cols = ["organization_id", ...Object.keys(result.values)];
    const vals = [orgId, ...Object.values(result.values)];
    try {
      const info = db
        .prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
        .run(...vals);
      const item = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(Number(info.lastInsertRowid));
      res.status(201).json({ item });
    } catch (err) {
      sendDbError(res, err);
    }
  });

  router.patch("/:id", (req, res) => {
    const orgId = req.auth!.organization.id;
    const id = Number(req.params.id);
    const existing = db.prepare(`SELECT 1 FROM ${table} WHERE id = ? AND organization_id = ?`).get(id, orgId);
    if (!existing) {
      res.status(404).json({ error: "Não encontrado" });
      return;
    }
    const result = validate(req.body ?? {}, fields, orgId, true);
    if ("error" in result) {
      res.status(400).json({ error: result.error });
      return;
    }
    const cols = Object.keys(result.values);
    if (cols.length === 0) {
      res.status(400).json({ error: "Nenhum campo para atualizar" });
      return;
    }
    try {
      db.prepare(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ? AND organization_id = ?`).run(
        ...Object.values(result.values),
        id,
        orgId,
      );
      res.json({ item: db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) });
    } catch (err) {
      sendDbError(res, err);
    }
  });

  router.delete("/:id", requireRole("admin"), (req, res) => {
    const info = db
      .prepare(`DELETE FROM ${table} WHERE id = ? AND organization_id = ?`)
      .run(Number(req.params.id), req.auth!.organization.id);
    if (info.changes === 0) {
      res.status(404).json({ error: "Não encontrado" });
      return;
    }
    res.status(204).end();
  });

  return router;
}

function sendDbError(res: import("express").Response, err: unknown): void {
  const message = err instanceof Error ? err.message : "";
  if (message.includes("UNIQUE")) {
    res.status(409).json({ error: "Registro duplicado" });
    return;
  }
  console.error(err);
  res.status(500).json({ error: "Erro interno" });
}
