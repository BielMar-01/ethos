/**
 * Documentos que já existem (contrato assinado, aditivos, laudos…), anexados a um contrato.
 * O arquivo original fica no PostgreSQL, privado: só a equipe autenticada, tipo conferido pelo CONTEÚDO, até 5 MB.
 */
import crypto from "node:crypto";
import express, { Router } from "express";
import { db, isUniqueViolation } from "./db.js";
import { requireAuth, requireRole } from "./auth.js";
import { parseId } from "./crud.js";
import { detectDoc } from "./propdocs.js";
import { isDocx } from "./docx.js";

export const leaseFilesRouter = Router();
const staff = [requireAuth, requireRole("admin", "colaborador")];
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_PER_LEASE = 50;
const KINDS = ["contrato", "aditivo", "vistoria", "garantia", "distrato", "outro"] as const;
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const EXT: Record<string, string> = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", [DOCX]: "docx" };
const raw = express.raw({ type: [...Object.keys(EXT), "application/octet-stream"], limit: MAX_BYTES });

const findLease = async (orgId: number, id: number | undefined) => (id ? (await db.query<{ id: number }>("SELECT id FROM leases WHERE id = $1 AND organization_id = $2", [id, orgId]))[0] : undefined);

leaseFilesRouter.post("/leases/:id/files", ...staff, raw, async (req, res) => {
  const orgId = req.auth!.organization.id;
  const lease = await findLease(orgId, parseId(req.params.id));
  if (!lease) return void res.status(404).json({ error: "Contrato não encontrado." });
  const kind = String(req.query.kind ?? "contrato");
  const title = typeof req.query.title === "string" ? req.query.title.trim().slice(0, 150) : "";
  if (!KINDS.includes(kind as never) || title.length < 2) return void res.status(400).json({ error: `Informe kind (${KINDS.join("|")}) e title (2+ letras) na URL.` });
  const body = req.body as unknown;
  if (!Buffer.isBuffer(body) || body.length === 0) return void res.status(400).json({ error: "Envie o arquivo (PDF, Word .docx, JPEG ou PNG, até 5 MB)." });
  const type = detectDoc(body) ?? (isDocx(body) ? DOCX : undefined);
  if (!type) return void res.status(400).json({ error: "O arquivo não é um PDF, Word (.docx), JPEG ou PNG válido." });
  const [count] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM lease_files WHERE lease_id = $1", [lease.id]);
  if (count!.n >= MAX_PER_LEASE) return void res.status(409).json({ error: `Limite de ${MAX_PER_LEASE} anexos por contrato.` });
  try {
    const [row] = await db.query<{ id: number }>(
      "INSERT INTO lease_files (organization_id, lease_id, kind, title, content_type, size_bytes, sha256, data, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id",
      [orgId, lease.id, kind, title, type, body.length, crypto.createHash("sha256").update(body).digest("hex"), body, req.auth!.user.id],
    );
    res.status(201).json({ id: row!.id });
  } catch (err) {
    if (isUniqueViolation(err)) return void res.status(409).json({ error: "Este mesmo arquivo já está anexado a este contrato." });
    throw err;
  }
});

leaseFilesRouter.get("/leases/:id/files", ...staff, async (req, res) => {
  const orgId = req.auth!.organization.id;
  const lease = await findLease(orgId, parseId(req.params.id));
  if (!lease) return void res.status(404).json({ error: "Contrato não encontrado." });
  const items = await db.query(
    `SELECT f.id, f.kind, f.title, f.content_type, f.size_bytes, f.created_at, u.name AS created_by_name
     FROM lease_files f LEFT JOIN users u ON u.id = f.created_by WHERE f.lease_id = $1 AND f.organization_id = $2 ORDER BY f.id DESC`,
    [lease.id, orgId],
  );
  res.json({ items });
});

leaseFilesRouter.get("/lease-files/:id/file", ...staff, async (req, res) => {
  const id = parseId(req.params.id);
  const [f] = id ? await db.query<{ content_type: string; data: Uint8Array; title: string }>("SELECT content_type, data, title FROM lease_files WHERE id = $1 AND organization_id = $2", [id, req.auth!.organization.id]) : [];
  if (!f) return void res.status(404).json({ error: "Não encontrado" });
  const name = `${f.title.normalize("NFD").replace(/\p{M}/gu, "").replace(/[^\w.-]+/g, "_").slice(0, 80)}.${EXT[f.content_type]}`;
  res.set({
    "Content-Type": f.content_type,
    // PDF e imagem abrem na aba; Word é baixado.
    "Content-Disposition": `${f.content_type === DOCX ? "attachment" : "inline"}; filename="${name}"`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.send(Buffer.from(f.data));
});

leaseFilesRouter.delete("/lease-files/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const id = parseId(req.params.id);
  const done = id ? await db.query("DELETE FROM lease_files WHERE id = $1 AND organization_id = $2 RETURNING id", [id, req.auth!.organization.id]) : [];
  if (done.length === 0) return void res.status(404).json({ error: "Não encontrado" });
  res.status(204).end();
});
