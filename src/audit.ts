import { Router, type NextFunction, type Request, type Response } from "express";
import { db } from "./db.js";
import { requireAuth, requireRole } from "./auth.js";

export type AuditKind = "create" | "update" | "delete" | "action" | "auth" | "denied" | "system";

export interface AuditEntry {
  organizationId: number;
  userId?: number | null;
  userName?: string | null;
  userEmail?: string | null;
  role?: string | null;
  kind: AuditKind;
  entity?: string | null;
  entityId?: number | null;
  summary: string;
  status?: number | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
}

/** Grava um evento. NUNCA lança: falha de auditoria não pode derrubar a ação do usuário (vai para o log do servidor). */
export async function recordAudit(e: AuditEntry): Promise<void> {
  try {
    await db.query(
      `INSERT INTO audit_logs (organization_id, user_id, user_name, user_email, role, kind, entity, entity_id,
                               summary, status, metadata, ip, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13)`,
      [
        e.organizationId,
        e.userId ?? null,
        e.userName ?? null,
        e.userEmail ?? null,
        e.role ?? null,
        e.kind,
        e.entity ?? null,
        e.entityId ?? null,
        e.summary.slice(0, 500),
        e.status ?? null,
        JSON.stringify(e.metadata ?? {}),
        e.ip ?? null,
        e.userAgent?.slice(0, 300) ?? null,
      ],
    );
  } catch (err) {
    console.error("Falha ao gravar auditoria:", err instanceof Error ? err.message : err);
  }
}

/** Dados da requisição que vão em todo evento (quem chamou e de onde). */
export function requestInfo(req: Request) {
  return { ip: req.ip ?? null, userAgent: req.get("user-agent") ?? null };
}

// ---------------------------------------------------------------------------------------------
// Registro automático de TODA escrita bem-sucedida (e de toda negação 403) sem tocar em cada rota.
// ---------------------------------------------------------------------------------------------

const ENTITY: Record<string, string> = {
  owners: "proprietário",
  tenants: "inquilino",
  properties: "imóvel",
  units: "unidade",
  leases: "contrato",
  "contract-templates": "modelo de contrato",
  charges: "cobrança",
  payments: "pagamento",
  transfers: "repasse",
  settings: "configuração",
  maintenance: "chamado de manutenção",
  inspections: "vistoria",
  photos: "foto",
  announcements: "comunicado",
  members: "membro da equipe",
  invitations: "convite",
  "api-keys": "chave de API",
  reminders: "lembretes",
  notifications: "notificações",
  portal: "área do cliente",
  auth: "sessão",
};

interface Rule {
  method: string;
  /** Caminho normalizado: ids numéricos viram :id e o token de convite vira :token. */
  path: RegExp;
  kind: AuditKind;
  summary: string;
}

const rules: Rule[] = [
  { method: "POST", path: /^\/api\/leases\/:id\/status$/, kind: "action", summary: "Mudou o status do contrato" },
  { method: "POST", path: /^\/api\/leases\/:id\/documents$/, kind: "create", summary: "Emitiu documento de contrato" },
  { method: "POST", path: /^\/api\/leases\/:id\/preview$/, kind: "system", summary: "" },
  { method: "POST", path: /^\/api\/charges\/generate$/, kind: "action", summary: "Gerou cobranças do mês" },
  { method: "POST", path: /^\/api\/charges\/:id\/cancel$/, kind: "action", summary: "Cancelou cobrança" },
  { method: "POST", path: /^\/api\/payments$/, kind: "create", summary: "Registrou pagamento" },
  { method: "POST", path: /^\/api\/payments\/:id\/void$/, kind: "action", summary: "Estornou pagamento" },
  { method: "POST", path: /^\/api\/transfers\/generate$/, kind: "action", summary: "Gerou repasses do mês" },
  { method: "POST", path: /^\/api\/transfers\/:id\/pay$/, kind: "action", summary: "Marcou repasse como pago" },
  { method: "PUT", path: /^\/api\/settings\/finance$/, kind: "update", summary: "Alterou a taxa de administração" },
  { method: "POST", path: /^\/api\/maintenance\/:id\/status$/, kind: "action", summary: "Mudou o status do chamado" },
  { method: "POST", path: /^\/api\/maintenance\/:id\/comments$/, kind: "create", summary: "Comentou em chamado" },
  { method: "POST", path: /^\/api\/maintenance\/:id\/photos$/, kind: "create", summary: "Anexou foto ao chamado" },
  { method: "POST", path: /^\/api\/maintenance\/:id\/quotes$/, kind: "create", summary: "Registrou orçamento" },
  { method: "POST", path: /^\/api\/maintenance\/:id\/quotes\/:id\/approve$/, kind: "action", summary: "Aprovou orçamento" },
  { method: "POST", path: /^\/api\/maintenance\/:id\/quotes\/:id\/reject$/, kind: "action", summary: "Recusou orçamento" },
  { method: "POST", path: /^\/api\/inspections\/:id\/status$/, kind: "action", summary: "Mudou o status da vistoria" },
  { method: "POST", path: /^\/api\/inspections\/:id\/items$/, kind: "create", summary: "Adicionou item à vistoria" },
  { method: "POST", path: /^\/api\/inspections\/:id\/items\/:id\/photos$/, kind: "create", summary: "Anexou foto à vistoria" },
  { method: "DELETE", path: /^\/api\/inspections\/:id\/items\/:id$/, kind: "delete", summary: "Removeu item da vistoria" },
  { method: "PATCH", path: /^\/api\/inspections\/:id\/items\/:id$/, kind: "update", summary: "Avaliou item da vistoria" },
  { method: "POST", path: /^\/api\/inspections\/:id\/signatures$/, kind: "action", summary: "Registrou ciência da vistoria" },
  { method: "POST", path: /^\/api\/portal\/(tenant|owner)\/inspections\/:id\/sign$/, kind: "action", summary: "Registrou ciência da vistoria" },
  { method: "POST", path: /^\/api\/portal\/tenant\/maintenance$/, kind: "create", summary: "Abriu chamado de manutenção" },
  { method: "POST", path: /^\/api\/portal\/tenant\/maintenance\/:id\/cancel$/, kind: "action", summary: "Cancelou o próprio chamado" },
  { method: "POST", path: /^\/api\/portal\/tenant\/maintenance\/:id\/comments$/, kind: "create", summary: "Comentou no próprio chamado" },
  { method: "POST", path: /^\/api\/portal\/tenant\/maintenance\/:id\/photos$/, kind: "create", summary: "Anexou foto ao próprio chamado" },
  { method: "POST", path: /^\/api\/announcements\/:id\/publish$/, kind: "action", summary: "Publicou comunicado" },
  { method: "POST", path: /^\/api\/announcements\/:id\/archive$/, kind: "action", summary: "Arquivou comunicado" },
  { method: "POST", path: /^\/api\/members\/:id\/password-reset$/, kind: "action", summary: "Redefiniu a senha de um membro" },
  { method: "POST", path: /^\/api\/invitations\/by-token\/:token\/accept$/, kind: "auth", summary: "Aceitou um convite" },
  { method: "POST", path: /^\/api\/invitations$/, kind: "create", summary: "Criou convite" },
  { method: "DELETE", path: /^\/api\/invitations\/:id$/, kind: "delete", summary: "Cancelou convite" },
  { method: "PATCH", path: /^\/api\/members\/:id$/, kind: "update", summary: "Alterou o papel de um membro" },
  { method: "DELETE", path: /^\/api\/members\/:id$/, kind: "delete", summary: "Removeu um membro da equipe" },
  { method: "POST", path: /^\/api\/api-keys$/, kind: "create", summary: "Criou chave de API" },
  { method: "DELETE", path: /^\/api\/api-keys\/:id$/, kind: "delete", summary: "Revogou chave de API" },
  { method: "POST", path: /^\/api\/reminders\/run$/, kind: "action", summary: "Executou os lembretes manualmente" },
  { method: "PUT", path: /^\/api\/properties\/:id\/owners$/, kind: "update", summary: "Alterou os proprietários do imóvel" },
  { method: "POST", path: /^\/api\/auth\/logout$/, kind: "auth", summary: "Saiu do sistema" },
  { method: "POST", path: /^\/api\/auth\/switch$/, kind: "auth", summary: "Trocou de organização" },
  { method: "POST", path: /^\/api\/auth\/login$/, kind: "auth", summary: "Entrou no sistema" },
  { method: "POST", path: /^\/api\/auth\/register$/, kind: "auth", summary: "Criou a organização e a conta" },
  { method: "DELETE", path: /^\/api\/photos\/:id$/, kind: "delete", summary: "Removeu foto" },
];

/** Escritas que não merecem registro (ruído sem valor de auditoria). */
const SKIP = [/^\/api\/import$/, /^\/api\/extract$/, /^\/api\/notifications/, /^\/api\/audit/, /^\/api\/auth\/(forgot|reset)$/, /\/preview$/];

const BODY_KEYS = ["status", "role", "mode", "month", "audience", "reason", "type"] as const;
const NAME_KEYS = ["name", "title", "description", "identifier", "email", "number"] as const;

const normalize = (p: string) =>
  p
    .replace(/\/by-token\/[^/]+/, "/by-token/:token")
    .replace(/\/\d+(?=\/|$)/g, "/:id")
    .replace(/\/+$/, "");

function find(obj: unknown, keys: readonly string[], depth = 0): string | undefined {
  if (!obj || typeof obj !== "object" || depth > 2) return undefined;
  const rec = obj as Record<string, unknown>;
  for (const k of keys) if (typeof rec[k] === "string" && rec[k]) return rec[k] as string;
  for (const v of Object.values(rec)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const hit = find(v, keys, depth + 1);
      if (hit) return hit;
    }
  }
  return undefined;
}

function findId(obj: unknown): number | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const rec = obj as Record<string, unknown>;
  if (typeof rec.id === "number") return rec.id;
  for (const v of Object.values(rec)) {
    if (v && typeof v === "object" && !Array.isArray(v) && typeof (v as { id?: unknown }).id === "number") {
      return (v as { id: number }).id;
    }
  }
  return undefined;
}

/** Descreve a requisição: usa a tabela de regras e cai num texto genérico (CRUD) para o resto. */
function describe(method: string, path: string): { kind: AuditKind; summary: string; entity: string } | null {
  const norm = normalize(path);
  const segs = path.split("/").filter(Boolean); // api, recurso, ...
  const resource = segs[1] === "portal" ? "portal" : (segs[1] ?? "");
  const rule = rules.find((r) => r.method === method && r.path.test(norm));
  if (rule) return rule.summary ? { kind: rule.kind, summary: rule.summary, entity: resource } : null;
  const noun = ENTITY[resource] ?? resource;
  if (method === "POST") return { kind: "create", summary: `Cadastrou ${noun}`, entity: resource };
  if (method === "PUT" || method === "PATCH") return { kind: "update", summary: `Alterou ${noun}`, entity: resource };
  if (method === "DELETE") return { kind: "delete", summary: `Excluiu ${noun}`, entity: resource };
  return null;
}

/** Middleware: registra, ao fim da resposta, toda escrita bem-sucedida e toda negação de permissão (403). */
export function auditMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return next();
  const path = req.originalUrl.split("?")[0]!;
  if (!path.startsWith("/api/") || SKIP.some((r) => r.test(path))) return next();

  // Guarda o corpo da resposta para extrair o id e um nome legível do que foi criado/alterado.
  let payload: unknown;
  const original = res.json.bind(res);
  res.json = ((body: unknown) => {
    payload = body;
    return original(body);
  }) as typeof res.json;

  res.on("finish", () => {
    const ok = res.statusCode >= 200 && res.statusCode < 300;
    const denied = res.statusCode === 403 && !!req.auth;
    if (!ok && !denied) return;
    const info = describe(req.method, path);
    if (!info) return;

    // Login, cadastro e aceite de convite ainda não têm sessão na requisição: o autor vem da resposta.
    const body = payload as { user?: { id: number; name: string; email: string }; organization?: { id: number }; role?: string };
    const actor = req.auth
      ? { organizationId: req.auth.organization.id, userId: req.auth.user.id, userName: req.auth.user.name, userEmail: req.auth.user.email, role: req.auth.role }
      : ok && body?.user && body.organization
        ? { organizationId: body.organization.id, userId: body.user.id, userName: body.user.name, userEmail: body.user.email, role: body.role }
        : null;
    if (!actor) return;

    const segs = path.split("/").filter(Boolean);
    const idInPath = segs.slice(2).find((s) => /^\d+$/.test(s));
    const entityId = idInPath ? Number(idInPath) : findId(payload);
    const label = ok && info.kind !== "auth" ? find(payload, NAME_KEYS) : undefined;
    const reqBody = (req.body ?? {}) as Record<string, unknown>;
    const metadata: Record<string, unknown> = { method: req.method, path: normalize(path) };
    for (const k of BODY_KEYS) if (typeof reqBody[k] === "string" || typeof reqBody[k] === "number") metadata[k] = reqBody[k];
    if (label) metadata.label = label;

    void recordAudit({
      ...actor,
      kind: denied ? "denied" : info.kind,
      entity: info.entity,
      entityId: entityId ?? null,
      summary: denied ? `Acesso negado: ${info.summary.toLowerCase()}` : `${info.summary}${label ? ` — ${label}` : ""}`,
      status: res.statusCode,
      metadata,
      ...requestInfo(req),
    });
  });
  next();
}

// ---------------------------------------------------------------------------------------------
// Consulta (somente administrador logado; chave de API nunca chega aqui).
// ---------------------------------------------------------------------------------------------

export const auditRouter = Router();
auditRouter.use("/audit", requireAuth, requireRole("admin"));

const KINDS = ["create", "update", "delete", "action", "auth", "denied", "system"];

interface Filters {
  where: string;
  params: unknown[];
}

function filtersFrom(req: Request): Filters | { error: string } {
  const q = req.query;
  const params: unknown[] = [req.auth!.organization.id];
  const where = ["organization_id = $1"];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replace("?", `$${params.length}`));
  };
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  if (str(q.q)) {
    params.push(`%${str(q.q).replace(/[\\%_]/g, "\\$&")}%`);
    const n = `$${params.length}`;
    where.push(`(summary ILIKE ${n} OR user_name ILIKE ${n} OR user_email ILIKE ${n} OR ip ILIKE ${n})`);
  }
  if (str(q.kind)) {
    if (!KINDS.includes(str(q.kind))) return { error: "Tipo inválido" };
    add("kind = ?", str(q.kind));
  }
  if (str(q.entity)) add("entity = ?", str(q.entity));
  if (str(q.user_id)) {
    if (!/^\d+$/.test(str(q.user_id))) return { error: "Usuário inválido" };
    add("user_id = ?", Number(str(q.user_id)));
  }
  for (const [key, op] of [["from", ">="], ["to", "<"]] as const) {
    const v = str(q[key]);
    if (!v) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) return { error: "Data inválida (use AAAA-MM-DD)" };
    // Dia inteiro no fuso de Brasília; "até" é inclusivo (limite = dia seguinte).
    add(
      key === "from"
        ? `created_at ${op} (?::date)::timestamp AT TIME ZONE 'America/Sao_Paulo'`
        : `created_at ${op} ((?::date) + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo'`,
      v,
    );
  }
  return { where: where.join(" AND "), params };
}

const COLUMNS = `id, user_id, user_name, user_email, role, kind, entity, entity_id, summary, status, metadata, ip, user_agent, created_at`;

auditRouter.get("/audit", async (req, res) => {
  const f = filtersFrom(req);
  if ("error" in f) {
    res.status(400).json({ error: f.error });
    return;
  }
  const { where, params } = f;
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
  const before = /^\d+$/.test(String(req.query.before ?? "")) ? String(req.query.before) : null;
  const p = [...params];
  let sql = `SELECT ${COLUMNS} FROM audit_logs WHERE ${where}`;
  if (before) {
    p.push(before);
    sql += ` AND id < $${p.length}`;
  }
  p.push(limit + 1);
  sql += ` ORDER BY id DESC LIMIT $${p.length}`;
  const rows = await db.query<{ id: string | number }>(sql, p);
  const items = rows.slice(0, limit).map((r) => ({ ...r, id: Number(r.id) }));
  res.json({ items, next_before: rows.length > limit ? items[items.length - 1]!.id : null });
});

/** Quem aparece no registro (para o filtro por pessoa). */
auditRouter.get("/audit/actors", async (req, res) => {
  const items = await db.query(
    `SELECT user_id, max(user_name) AS user_name, max(user_email) AS user_email
       FROM audit_logs WHERE organization_id = $1 AND user_id IS NOT NULL
      GROUP BY user_id ORDER BY max(user_name)`,
    [req.auth!.organization.id],
  );
  res.json({ items });
});

const csvCell = (v: unknown) => {
  let s = v == null ? "" : String(v);
  // Evita injeção de fórmula ao abrir no Excel/Planilhas.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replaceAll('"', '""')}"`;
};

auditRouter.get("/audit/export", async (req, res) => {
  const f = filtersFrom(req);
  if ("error" in f) {
    res.status(400).json({ error: f.error });
    return;
  }
  const rows = await db.query<Record<string, unknown>>(
    `SELECT ${COLUMNS} FROM audit_logs WHERE ${f.where} ORDER BY id DESC LIMIT 5000`,
    f.params,
  );
  const head = ["Data/hora (UTC)", "Pessoa", "E-mail", "Papel", "Tipo", "Recurso", "Id", "O que aconteceu", "Status", "IP"];
  const lines = rows.map((r) =>
    [r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at, r.user_name, r.user_email, r.role, r.kind, r.entity, r.entity_id, r.summary, r.status, r.ip]
      .map(csvCell)
      .join(","),
  );
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="auditoria-ethos.csv"');
  res.send("﻿" + [head.map(csvCell).join(","), ...lines].join("\r\n"));
});
