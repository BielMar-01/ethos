import crypto from "node:crypto";
import { Router } from "express";
import { db, transaction } from "./db.js";
import { requireAuth, requireRole } from "./auth.js";
import { appUrl } from "./authProvider.js";
import { parseId } from "./crud.js";
import { sendEmail } from "./mailer.js";
import { notify } from "./notifications.js";
import { SharedRateLimiter } from "./ratelimit.js";

/**
 * Assinatura eletrônica SIMPLES dos documentos de contrato emitidos: cada pessoa recebe um link único, lê o texto
 * exato que foi emitido (hash SHA-256 gravado), digita o próprio nome e confirma. Ficam registrados data/hora, IP e navegador.
 * NÃO é assinatura qualificada (ICP-Brasil/gov.br). Serve como prova de concordância; para assinatura qualificada use um
 * provedor (D4Sign, ClickSign, gov.br) e anexe o PDF assinado.
 */
export const signaturesRouter = Router();
const staff = [requireAuth, requireRole("admin", "colaborador")];
const hash = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const publicLimiter = new SharedRateLimiter("sign", 60, 15 * 60 * 1000);
const ROLES = ["locador", "locatario", "fiador", "testemunha", "outro"] as const;
const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();

interface DocRow {
  id: number;
  content: string;
  template_name: string;
  lease_id: number;
}

async function findDoc(orgId: number, id: number | undefined): Promise<DocRow | undefined> {
  if (!id) return undefined;
  return (await db.query<DocRow>("SELECT id, content, template_name, lease_id FROM contract_documents WHERE id = $1 AND organization_id = $2", [id, orgId]))[0];
}

signaturesRouter.post("/documents/:id/signature", ...staff, async (req, res) => {
  const orgId = req.auth!.organization.id;
  const doc = await findDoc(orgId, parseId(req.params.id));
  if (!doc) return void res.status(404).json({ error: "Documento não encontrado." });
  const raw = Array.isArray(req.body?.signers) ? req.body.signers : [];
  if (raw.length < 1 || raw.length > 8) return void res.status(400).json({ error: "Informe de 1 a 8 signatários." });
  const signers: { name: string; email: string | null; role: string; token: string }[] = [];
  for (const s of raw) {
    const name = typeof s?.name === "string" ? s.name.trim().replace(/\s+/g, " ") : "";
    const email = typeof s?.email === "string" && s.email.trim() ? s.email.trim().toLowerCase() : null;
    if (name.length < 3 || name.length > 120 || !ROLES.includes(s?.role) || (email && !/^\S+@\S+\.\S+$/.test(email))) return void res.status(400).json({ error: "Cada signatário precisa de nome (3+ letras), papel válido e, se informado, e-mail válido." });
    signers.push({ name, email, role: s.role, token: crypto.randomBytes(24).toString("base64url") });
  }
  const out = await transaction(async (tx) => {
    const open = await tx.query("SELECT 1 FROM signature_requests WHERE document_id = $1 AND status = 'pendente'", [doc.id]);
    if (open.length > 0) return { code: 409, error: "Este documento já tem uma coleta de assinaturas em andamento. Cancele-a para iniciar outra." };
    const [r] = await tx.query<{ id: number }>("INSERT INTO signature_requests (organization_id, document_id, content_hash, created_by) VALUES ($1,$2,$3,$4) RETURNING id", [orgId, doc.id, hash(doc.content), req.auth!.user.id]);
    for (const s of signers) await tx.query("INSERT INTO signers (request_id, organization_id, name, email, role, token_hash) VALUES ($1,$2,$3,$4,$5,$6)", [r!.id, orgId, s.name, s.email, s.role, hash(s.token)]);
    return { code: 201, id: r!.id };
  });
  if (out.code !== 201) return void res.status(out.code).json({ error: out.error });
  let emailed = 0;
  for (const s of signers) {
    if (s.email && (await sendEmail({ to: s.email, subject: `Assinatura do documento: ${doc.template_name}`, text: `Olá, ${s.name}.\n\nHá um documento aguardando a sua assinatura (${doc.template_name}).\nLeia e assine pelo link (pessoal, não compartilhe):\n${appUrl()}/?sign=${s.token}\n\nA assinatura é eletrônica simples: você digita o seu nome e confirma. Ficam registrados data, hora e IP.` }))) emailed++;
  }
  // Os links só aparecem agora (guardamos apenas o hash).
  res.status(201).json({ request_id: out.id, content_hash: hash(doc.content), emailed, links: signers.map((s) => ({ name: s.name, role: s.role, email: s.email, link: `${appUrl()}/?sign=${s.token}` })) });
});

async function latest(orgId: number, docId: number) {
  const [r] = await db.query<{ id: number; status: string; content_hash: string; created_at: string; completed_at: string | null }>(
    "SELECT id, status, content_hash, created_at, completed_at FROM signature_requests WHERE document_id = $1 AND organization_id = $2 ORDER BY id DESC LIMIT 1", [docId, orgId]);
  if (!r) return null;
  const signers = await db.query("SELECT id, name, email, role, viewed_at, signed_at, signed_ip FROM signers WHERE request_id = $1 ORDER BY id", [r.id]);
  return { ...r, signers };
}

signaturesRouter.get("/documents/:id/signature", ...staff, async (req, res) => {
  const id = parseId(req.params.id);
  const doc = await findDoc(req.auth!.organization.id, id);
  if (!doc) return void res.status(404).json({ error: "Documento não encontrado." });
  res.json({ item: await latest(req.auth!.organization.id, doc.id) });
});

signaturesRouter.post("/documents/:id/signature/cancel", ...staff, async (req, res) => {
  const doc = await findDoc(req.auth!.organization.id, parseId(req.params.id));
  const done = doc ? await db.query("UPDATE signature_requests SET status = 'cancelada' WHERE document_id = $1 AND status = 'pendente' RETURNING id", [doc.id]) : [];
  if (done.length === 0) return void res.status(404).json({ error: "Não há coleta de assinaturas em andamento." });
  res.status(204).end();
});

/** Certificado em texto: o que foi assinado (hash) e as evidências de cada pessoa. */
signaturesRouter.get("/documents/:id/signature/certificate", ...staff, async (req, res) => {
  const doc = await findDoc(req.auth!.organization.id, parseId(req.params.id));
  const r = doc ? await latest(req.auth!.organization.id, doc.id) : null;
  if (!doc || !r || r.status !== "concluida") return void res.status(409).json({ error: "O certificado só existe depois que todos assinam." });
  const when = (s: string | null) => (s ? new Date(s).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "—");
  const lines = [
    "CERTIFICADO DE ASSINATURA ELETRÔNICA SIMPLES", "",
    `Documento: ${doc.template_name} (nº ${doc.id}), contrato nº ${doc.lease_id}`,
    `Hash SHA-256 do texto assinado: ${r.content_hash}`,
    `Coleta iniciada em ${when(r.created_at)} e concluída em ${when(r.completed_at)}.`, "",
    "Assinaturas:",
    ...(r.signers as { name: string; role: string; signed_at: string; signed_ip: string | null }[]).map((s) => `- ${s.name} (${s.role}) — ${when(s.signed_at)} — IP ${s.signed_ip ?? "n/d"}`), "",
    "Assinatura eletrônica simples: cada pessoa acessou um link pessoal, leu o texto, digitou o próprio nome e confirmou.",
    "Não é assinatura qualificada (ICP-Brasil). Guarde este certificado junto com o documento.",
  ];
  res.set({ "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": `attachment; filename="certificado-assinatura-${doc.id}.txt"` });
  res.send(lines.join("\n"));
});

// ------------------------------------------------------------------ Público (quem assina)

async function bySigner(token: string) {
  const [s] = await db.query<{ id: number; request_id: number; organization_id: number; name: string; role: string; signed_at: string | null; status: string; content_hash: string; document_id: number; created_by: number | null }>(
    `SELECT s.id, s.request_id, s.organization_id, s.name, s.role, s.signed_at, r.status, r.content_hash, r.document_id, r.created_by
     FROM signers s JOIN signature_requests r ON r.id = s.request_id WHERE s.token_hash = $1`,
    [hash(token)],
  );
  return s;
}

signaturesRouter.get("/sign/:token", async (req, res) => {
  if (!(await publicLimiter.allow(`ip:${req.ip}`))) return void res.status(429).json({ error: "Muitas tentativas. Tente novamente em alguns minutos." });
  const s = await bySigner(String(req.params.token));
  if (!s || s.status === "cancelada") return void res.status(404).json({ error: "Link inválido ou cancelado." });
  const [doc] = await db.query<{ content: string; template_name: string; number: string | null; format: number; layout: unknown }>("SELECT content, template_name, number, format, layout FROM contract_documents WHERE id = $1", [s.document_id]);
  await db.query("UPDATE signers SET viewed_at = COALESCE(viewed_at, now()) WHERE id = $1", [s.id]);
  const others = await db.query<{ name: string; role: string; signed: boolean }>("SELECT name, role, (signed_at IS NOT NULL) AS signed FROM signers WHERE request_id = $1 ORDER BY id", [s.request_id]);
  res.json({ document: { title: doc!.template_name, content: doc!.content, number: doc!.number, format: doc!.format, layout: doc!.layout, hash: s.content_hash }, signer: { name: s.name, role: s.role, signed_at: s.signed_at }, status: s.status, others });
});

signaturesRouter.post("/sign/:token", async (req, res) => {
  if (!(await publicLimiter.allow(`ip:${req.ip}`))) return void res.status(429).json({ error: "Muitas tentativas. Tente novamente em alguns minutos." });
  const s = await bySigner(String(req.params.token));
  if (!s || s.status === "cancelada") return void res.status(404).json({ error: "Link inválido ou cancelado." });
  if (s.signed_at) return void res.status(409).json({ error: "Você já assinou este documento." });
  if (req.body?.accept !== true) return void res.status(400).json({ error: "Confirme que leu e concorda com o documento." });
  const typed = typeof req.body?.signed_name === "string" ? req.body.signed_name : "";
  if (norm(typed) !== norm(s.name)) return void res.status(400).json({ error: `Digite o seu nome completo exatamente como aparece: ${s.name}.` });
  const out = await transaction(async (tx) => {
    const [r] = await tx.query<{ status: string }>("SELECT status FROM signature_requests WHERE id = $1 FOR UPDATE", [s.request_id]);
    if (r?.status !== "pendente") return { done: false };
    const upd = await tx.query("UPDATE signers SET signed_at = now(), signed_name = $2, signed_ip = $3, signed_user_agent = $4 WHERE id = $1 AND signed_at IS NULL RETURNING id", [s.id, typed.trim().slice(0, 120), req.ip ?? null, req.get("user-agent")?.slice(0, 300) ?? null]);
    if (upd.length === 0) return { done: false };
    const [left] = await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM signers WHERE request_id = $1 AND signed_at IS NULL", [s.request_id]);
    if (left!.n === 0) await tx.query("UPDATE signature_requests SET status = 'concluida', completed_at = now() WHERE id = $1", [s.request_id]);
    return { done: true, completed: left!.n === 0 };
  });
  if (!out.done) return void res.status(409).json({ error: "Não foi possível registrar a assinatura (já assinada ou coleta encerrada)." });
  if (s.created_by) {
    await notify(s.organization_id, [s.created_by], { category: "contrato", kind: "signature", title: out.completed ? "Documento totalmente assinado" : "Nova assinatura recebida", body: `${s.name} (${s.role}) assinou.${out.completed ? " Todas as assinaturas foram coletadas." : ""}`, linkKind: "document", linkId: s.document_id });
  }
  res.json({ signed: true, completed: !!out.completed });
});
