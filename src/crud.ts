import { Router, type Response } from "express";
import { db, isForeignKeyViolation, isUniqueViolation } from "./db.js";
import { requireAuth, requireRole } from "./auth.js";

export type Field = {
  name: string;
  required?: boolean;
  max?: number;
} & (
  | { kind: "string"; email?: boolean }
  | { kind: "int"; min?: number; maxValue?: number }
  | { kind: "date" }
  | { kind: "enum"; values: readonly string[] }
  /** Chave estrangeira: o registro referenciado precisa ser da mesma organização. */
  | { kind: "ref"; table: string }
);

type Value = string | number | null;
type Result = { values: Record<string, Value> } | { error: string };

const INT4_MAX = 2_147_483_647;

/** "AAAA-MM-DD" que existe no calendário (rejeita 2026-02-30). */
export function isRealDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/** Converte um parâmetro de rota em id válido (int4 positivo) ou undefined. */
export function parseId(raw: unknown): number | undefined {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n <= INT4_MAX ? n : undefined;
}

export async function validate(
  body: Record<string, unknown>,
  fields: Field[],
  organizationId: number,
  partial: boolean,
): Promise<Result> {
  const values: Record<string, Value> = {};
  for (const f of fields) {
    const v = body[f.name];
    if (v === undefined) {
      if (!partial && f.required) return { error: `Campo obrigatório: ${f.name}` };
      continue;
    }
    if (v === null || v === "") {
      if (f.required) return { error: `Campo obrigatório: ${f.name}` };
      // Enum vazio = "não informado": usa o padrão do banco (criar) ou mantém o valor (editar). Gravar NULL violaria NOT NULL.
      if (f.kind === "enum") continue;
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
        if (typeof v !== "number" || !Number.isInteger(v) || v < (f.min ?? 0) || v > (f.maxValue ?? INT4_MAX)) {
          return { error: `Número inválido: ${f.name}` };
        }
        values[f.name] = v;
        break;
      }
      case "date": {
        if (typeof v !== "string" || !isRealDate(v)) return { error: `Data inválida: ${f.name} (use AAAA-MM-DD)` };
        values[f.name] = v;
        break;
      }
      case "enum": {
        if (typeof v !== "string" || !f.values.includes(v)) return { error: `Valor inválido: ${f.name}` };
        values[f.name] = v;
        break;
      }
      case "ref": {
        const id = parseId(v);
        if (id === undefined) return { error: `Referência inválida: ${f.name}` };
        const found = await db.query(`SELECT 1 FROM ${f.table} WHERE id = $1 AND organization_id = $2`, [
          id,
          organizationId,
        ]);
        if (found.length === 0) return { error: `Referência inexistente: ${f.name}` };
        values[f.name] = id;
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
  router.use(requireAuth, requireRole("admin", "colaborador"));

  router.get("/", async (req, res) => {
    const items = await db.query(`SELECT * FROM ${table} WHERE organization_id = $1 ORDER BY ${orderBy}`, [
      req.auth!.organization.id,
    ]);
    res.json({ items });
  });

  router.get("/:id", async (req, res) => {
    const id = parseId(req.params.id);
    const [item] = id
      ? await db.query(`SELECT * FROM ${table} WHERE id = $1 AND organization_id = $2`, [
          id,
          req.auth!.organization.id,
        ])
      : [];
    if (!item) {
      res.status(404).json({ error: "Não encontrado" });
      return;
    }
    res.json({ item });
  });

  router.post("/", async (req, res) => {
    const orgId = req.auth!.organization.id;
    const result = await validate(req.body ?? {}, fields, orgId, false);
    if ("error" in result) {
      res.status(400).json({ error: result.error });
      return;
    }
    const cols = ["organization_id", ...Object.keys(result.values)];
    const vals = [orgId, ...Object.values(result.values)];
    try {
      const [item] = await db.query(
        `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`,
        vals,
      );
      res.status(201).json({ item });
    } catch (err) {
      sendDbError(res, err);
    }
  });

  router.patch("/:id", async (req, res) => {
    const orgId = req.auth!.organization.id;
    const id = parseId(req.params.id);
    const existing = id
      ? await db.query(`SELECT 1 FROM ${table} WHERE id = $1 AND organization_id = $2`, [id, orgId])
      : [];
    if (existing.length === 0) {
      res.status(404).json({ error: "Não encontrado" });
      return;
    }
    const result = await validate(req.body ?? {}, fields, orgId, true);
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
      const sets = cols.map((c, i) => `${c} = $${i + 1}`).join(", ");
      const [item] = await db.query(
        `UPDATE ${table} SET ${sets} WHERE id = $${cols.length + 1} AND organization_id = $${cols.length + 2} RETURNING *`,
        [...Object.values(result.values), id, orgId],
      );
      res.json({ item });
    } catch (err) {
      sendDbError(res, err);
    }
  });

  router.delete("/:id", requireRole("admin"), async (req, res) => {
    const id = parseId(req.params.id);
    let deleted: unknown[] = [];
    try {
      deleted = id
        ? await db.query(`DELETE FROM ${table} WHERE id = $1 AND organization_id = $2 RETURNING id`, [
            id,
            req.auth!.organization.id,
          ])
        : [];
    } catch (err) {
      if (isForeignKeyViolation(err)) {
        res.status(409).json({ error: "Registro em uso (possui contratos ou vínculos) e não pode ser excluído" });
        return;
      }
      throw err;
    }
    if (deleted.length === 0) {
      res.status(404).json({ error: "Não encontrado" });
      return;
    }
    res.status(204).end();
  });

  return router;
}

function sendDbError(res: Response, err: unknown): void {
  if (isUniqueViolation(err)) {
    res.status(409).json({ error: "Registro duplicado" });
    return;
  }
  throw err; // vai ao tratador de erros global (500 genérico, sem vazar detalhes)
}
