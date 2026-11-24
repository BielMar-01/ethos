import express, { Router } from "express";
import { db } from "./db.js";
import { requireAuth, requireRole } from "./auth.js";
import { isRealDate, parseId } from "./crud.js";
import { brToday } from "./finance.js";
import { notify } from "./notifications.js";
import { periodicJobs } from "./reminders.js";
import { formatDate } from "./contractTemplate.js";

/**
 * Documentos do imóvel (matrícula, IPTU, seguro, habite-se, laudos…) com vencimento e alerta.
 * Ficam no PostgreSQL (privados, só pela API autenticada da equipe), tipo conferido pelo CONTEÚDO, até 5 MB.
 */
export const propDocsRouter = Router();
const staff = [requireAuth, requireRole("admin", "colaborador")];
const MAX_BYTES = 5 * 1024 * 1024;
const KINDS = ["matricula", "iptu", "seguro", "habitese", "laudo", "contrato", "outro"] as const;
const raw = express.raw({ type: ["application/pdf", "image/jpeg", "image/png"], limit: MAX_BYTES });

export function detectDoc(buf: Buffer): "application/pdf" | "image/jpeg" | "image/png" | undefined {
  if (buf.length >= 5 && buf.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  return undefined;
}

const COLS = "d.id, d.property_id, d.kind, d.title, to_char(d.expires_at,'YYYY-MM-DD') AS expires_at, d.content_type, d.size_bytes, d.created_at, p.name AS property_name";

propDocsRouter.post("/properties/:id/documents", ...staff, raw, async (req, res) => {
  const orgId = req.auth!.organization.id;
  const propertyId = parseId(req.params.id);
  const [p] = propertyId ? await db.query("SELECT 1 FROM properties WHERE id = $1 AND organization_id = $2", [propertyId, orgId]) : [];
  if (!p) return void res.status(404).json({ error: "Imóvel não encontrado." });
  const kind = String(req.query.kind ?? "outro");
  const title = typeof req.query.title === "string" ? req.query.title.trim().slice(0, 150) : "";
  const expires = req.query.expires_at ? String(req.query.expires_at) : null;
  if (!KINDS.includes(kind as never) || title.length < 2) return void res.status(400).json({ error: `Informe kind (${KINDS.join("|")}) e title (2+ letras) na URL.` });
  if (expires && !isRealDate(expires)) return void res.status(400).json({ error: "expires_at inválida (AAAA-MM-DD)." });
  const body = req.body as unknown;
  if (!Buffer.isBuffer(body) || body.length === 0) return void res.status(400).json({ error: "Envie o arquivo (PDF, JPEG ou PNG, até 5 MB) no corpo da requisição." });
  const type = detectDoc(body);
  if (!type) return void res.status(400).json({ error: "O arquivo não é um PDF, JPEG ou PNG válido." });
  const [n] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM property_documents WHERE property_id = $1", [propertyId]);
  if (n!.n >= 100) return void res.status(409).json({ error: "Limite de 100 documentos por imóvel." });
  const [row] = await db.query<{ id: number }>(
    "INSERT INTO property_documents (organization_id, property_id, kind, title, expires_at, content_type, size_bytes, data, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id",
    [orgId, propertyId, kind, title, expires, type, body.length, body, req.auth!.user.id],
  );
  res.status(201).json({ id: row!.id });
});

propDocsRouter.get("/properties/:id/documents", ...staff, async (req, res) => {
  const id = parseId(req.params.id);
  const items = id ? await db.query(`SELECT ${COLS} FROM property_documents d JOIN properties p ON p.id = d.property_id WHERE d.property_id = $1 AND d.organization_id = $2 ORDER BY d.expires_at NULLS LAST, d.id DESC`, [id, req.auth!.organization.id]) : [];
  res.json({ items });
});

/** Todos os documentos (da organização) que vencem em até N dias ou já venceram. */
propDocsRouter.get("/property-documents/expiring", ...staff, async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 60, 1), 365);
  const items = await db.query(
    `SELECT ${COLS}, (d.expires_at - $2::date)::int AS days_left FROM property_documents d JOIN properties p ON p.id = d.property_id
     WHERE d.organization_id = $1 AND d.expires_at IS NOT NULL AND d.expires_at <= $2::date + $3::int ORDER BY d.expires_at LIMIT 300`,
    [req.auth!.organization.id, brToday(), days],
  );
  res.json({ items });
});

propDocsRouter.get("/property-documents/:id/file", ...staff, async (req, res) => {
  const id = parseId(req.params.id);
  const [d] = id ? await db.query<{ content_type: string; data: Uint8Array; title: string }>("SELECT content_type, data, title FROM property_documents WHERE id = $1 AND organization_id = $2", [id, req.auth!.organization.id]) : [];
  if (!d) return void res.status(404).json({ error: "Não encontrado" });
  const ext = d.content_type === "application/pdf" ? "pdf" : d.content_type === "image/png" ? "png" : "jpg";
  res.set({ "Content-Type": d.content_type, "Content-Disposition": `inline; filename="${d.title.replace(/[^\w.-]+/g, "_").slice(0, 80)}.${ext}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
  res.send(Buffer.from(d.data));
});

propDocsRouter.patch("/property-documents/:id", ...staff, async (req, res) => {
  const id = parseId(req.params.id);
  const exp = req.body?.expires_at;
  if (exp !== undefined && exp !== null && !isRealDate(String(exp))) return void res.status(400).json({ error: "expires_at inválida (AAAA-MM-DD)." });
  const title = typeof req.body?.title === "string" && req.body.title.trim().length >= 2 ? req.body.title.trim().slice(0, 150) : null;
  const done = id ? await db.query("UPDATE property_documents SET title = COALESCE($3, title), expires_at = CASE WHEN $4 THEN $5::date ELSE expires_at END, alert_stage = CASE WHEN $4 THEN 0 ELSE alert_stage END WHERE id = $1 AND organization_id = $2 RETURNING id", [id, req.auth!.organization.id, title, exp !== undefined, exp ?? null]) : [];
  if (done.length === 0) return void res.status(404).json({ error: "Não encontrado" });
  res.json({ ok: true });
});

propDocsRouter.delete("/property-documents/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const id = parseId(req.params.id);
  const done = id ? await db.query("DELETE FROM property_documents WHERE id = $1 AND organization_id = $2 RETURNING id", [id, req.auth!.organization.id]) : [];
  if (done.length === 0) return void res.status(404).json({ error: "Não encontrado" });
  res.status(204).end();
});

/** Aviso à equipe aos 30 dias do vencimento e outro quando vence. */
export async function runPropertyDocAlerts(): Promise<number> {
  const today = brToday();
  const rows = await db.query<{ id: number; organization_id: number; title: string; property_name: string; expires_at: string; expired: boolean }>(
    `UPDATE property_documents d SET alert_stage = CASE WHEN d.expires_at < $1::date THEN 2 ELSE 1 END FROM properties p
     WHERE p.id = d.property_id AND d.expires_at IS NOT NULL AND d.expires_at <= $1::date + 30
       AND d.alert_stage < CASE WHEN d.expires_at < $1::date THEN 2 ELSE 1 END
     RETURNING d.id, d.organization_id, d.title, p.name AS property_name, to_char(d.expires_at,'YYYY-MM-DD') AS expires_at, (d.expires_at < $1::date) AS expired`,
    [today],
  );
  let n = 0;
  for (const d of rows) {
    const staffIds = (await db.query<{ user_id: number }>("SELECT user_id FROM organization_members WHERE organization_id = $1 AND role IN ('admin','colaborador')", [d.organization_id])).map((r) => r.user_id);
    n += await notify(d.organization_id, staffIds, { category: "contrato", kind: "property_doc", title: d.expired ? "Documento do imóvel vencido" : "Documento do imóvel perto de vencer", body: `${d.title} (${d.property_name}) ${d.expired ? "venceu" : "vence"} em ${formatDate(d.expires_at)}.`, linkKind: "property", linkId: d.id });
  }
  return n;
}
periodicJobs.push({ name: "documentos de imóvel perto de vencer", run: () => runPropertyDocAlerts() });
