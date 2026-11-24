import crypto from "node:crypto";
import express, { Router } from "express";
import { db } from "./db.js";
import { requireAuth, requireRole } from "./auth.js";
import { isRealDate, parseId } from "./crud.js";
import { CHARGE_SELECT, brToday, recordPayment } from "./finance.js";

/**
 * Conciliação bancária: importa o extrato (OFX ou CSV), mostra os créditos ainda não conciliados com sugestões de
 * cobrança (valor, nome do pagador, nosso número do boleto) e, ao confirmar, registra o pagamento com recibo e baixa.
 * CNAB (remessa/retorno) NÃO é lido: o layout muda de banco para banco; precisa de um arquivo de exemplo do seu banco.
 */
export const bankRouter = Router();
const staff = [requireAuth, requireRole("admin", "colaborador")];

export interface BankTxn {
  fitid: string;
  posted_at: string;
  amount_cents: number;
  memo: string;
}

// ------------------------------------------------------------------ Leitura dos arquivos

const tag = (block: string, name: string) => new RegExp(`<${name}>([^<\\r\\n]*)`, "i").exec(block)?.[1]?.trim();

/** OFX 1.x (SGML) e 2.x (XML): lê os blocos STMTTRN. */
export function parseOfx(text: string): BankTxn[] {
  const out: BankTxn[] = [];
  const re = /<STMTTRN>([\s\S]*?)(?=<\/STMTTRN>|<STMTTRN>|<\/BANKTRANLIST>|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const block = m[1]!;
    const dt = tag(block, "DTPOSTED");
    const amt = tag(block, "TRNAMT");
    if (!dt || !amt || !/^\d{8}/.test(dt)) continue;
    const posted = `${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6, 8)}`;
    if (!isRealDate(posted)) continue;
    const value = Number(amt.replace(",", "."));
    if (!Number.isFinite(value)) continue;
    const memo = [tag(block, "MEMO"), tag(block, "NAME")].filter(Boolean).join(" — ");
    const cents = Math.round(value * 100);
    out.push({ fitid: tag(block, "FITID") || hashLine(posted, cents, memo, out.length), posted_at: posted, amount_cents: cents, memo: memo.slice(0, 300) });
  }
  return out;
}

const hashLine = (date: string, cents: number, memo: string, n: number) => "h" + crypto.createHash("sha256").update(`${date}|${cents}|${memo}|${n}`).digest("hex").slice(0, 24);

function parseMoney(s: string): number | null {
  let v = s.replace(/[R$\s]/g, "");
  if (/,\d{1,2}$/.test(v)) v = v.replace(/\./g, "").replace(",", ".");
  else v = v.replace(/,/g, "");
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

function parseDate(s: string): string | null {
  const t = s.trim();
  const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(t);
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  const d = br ? `${br[3]}-${br[2]}-${br[1]}` : iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : null;
  return d && isRealDate(d) ? d : null;
}

/** CSV de extrato: precisa de colunas de data, descrição/histórico e valor (separador ; , ou tab; com cabeçalho). */
export function parseCsv(text: string): BankTxn[] {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const sep = [";", "\t", ","].map((s) => [s, lines[0]!.split(s).length] as const).sort((a, b) => b[1] - a[1])[0]![0];
  const cells = (l: string) => l.split(sep).map((c) => c.trim().replace(/^"|"$/g, ""));
  const head = cells(lines[0]!).map((h) => h.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""));
  const find = (...names: string[]) => head.findIndex((h) => names.some((n) => h.includes(n)));
  const iDate = find("data");
  const iMemo = find("descri", "historico", "memo", "lancamento");
  const iAmount = find("valor", "amount");
  if (iDate < 0 || iAmount < 0) return [];
  const out: BankTxn[] = [];
  for (const l of lines.slice(1)) {
    const c = cells(l);
    const date = parseDate(c[iDate] ?? "");
    const cents = parseMoney(c[iAmount] ?? "");
    if (!date || cents === null) continue;
    const memo = (iMemo >= 0 ? c[iMemo] : "") ?? "";
    out.push({ fitid: hashLine(date, cents, memo, out.length), posted_at: date, amount_cents: cents, memo: memo.slice(0, 300) });
  }
  return out;
}

// ------------------------------------------------------------------ Rotas

bankRouter.post("/bank/import", express.json({ limit: "3mb" }), ...staff, async (req, res) => {
  const orgId = req.auth!.organization.id;
  const filename = typeof req.body?.filename === "string" ? req.body.filename.slice(0, 200) : "extrato";
  const content = req.body?.content;
  if (typeof content !== "string" || content.length < 20 || content.length > 3_000_000) return void res.status(400).json({ error: "Envie o conteúdo do arquivo (OFX ou CSV, até 3 MB)." });
  const isOfx = /<OFX|<STMTTRN/i.test(content);
  const txns = isOfx ? parseOfx(content) : parseCsv(content);
  if (txns.length === 0) return void res.status(422).json({ error: isOfx ? "Nenhum lançamento encontrado no OFX." : "Não reconheci o CSV. Use colunas de data, descrição e valor, com cabeçalho. Para o Excel do banco, exporte como OFX se possível." });
  if (txns.length > 5000) return void res.status(422).json({ error: "Arquivo com mais de 5000 lançamentos. Divida por período." });
  const [st] = await db.query<{ id: number }>("INSERT INTO bank_statements (organization_id, filename, source, imported_by) VALUES ($1, $2, $3, $4) RETURNING id", [orgId, filename, isOfx ? "ofx" : "csv", req.auth!.user.id]);
  let added = 0;
  for (const t of txns) {
    const r = await db.query(
      `INSERT INTO bank_lines (organization_id, statement_id, fitid, posted_at, amount_cents, memo, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (organization_id, fitid) DO NOTHING RETURNING id`,
      [orgId, st!.id, t.fitid, t.posted_at, t.amount_cents, t.memo, t.amount_cents > 0 ? "pendente" : "ignorada"],
    );
    added += r.length;
  }
  res.status(201).json({ statement_id: st!.id, source: isOfx ? "ofx" : "csv", read: txns.length, added, duplicated: txns.length - added, credits: txns.filter((t) => t.amount_cents > 0).length });
});

bankRouter.get("/bank/lines", ...staff, async (req, res) => {
  const status = ["pendente", "conciliada", "ignorada"].includes(String(req.query.status)) ? String(req.query.status) : "pendente";
  const items = await db.query(
    `SELECT l.id, l.posted_at, l.amount_cents, l.memo, l.status, l.payment_id, p.receipt_number
     FROM bank_lines l LEFT JOIN payments p ON p.id = l.payment_id
     WHERE l.organization_id = $1 AND l.status = $2 ORDER BY l.posted_at DESC, l.id DESC LIMIT 500`,
    [req.auth!.organization.id, status],
  );
  const [count] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM bank_lines WHERE organization_id = $1 AND status = 'pendente'", [req.auth!.organization.id]);
  res.json({ items, pending: count!.n });
});

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]/g, " ");

/** Sugere cobranças abertas para um crédito: nosso número no histórico, valor exato e nome do pagador. */
bankRouter.get("/bank/lines/:id/suggestions", ...staff, async (req, res) => {
  const orgId = req.auth!.organization.id;
  const id = parseId(req.params.id);
  const [line] = id ? await db.query<{ amount_cents: number; posted_at: string; memo: string }>("SELECT amount_cents, to_char(posted_at,'YYYY-MM-DD') AS posted_at, memo FROM bank_lines WHERE id = $1 AND organization_id = $2", [id, orgId]) : [];
  if (!line) return void res.status(404).json({ error: "Não encontrado" });
  const open = await db.query<{ id: number; lease_id: number; description: string; due_date: string; amount_cents: number; paid_cents: number; tenant_names: string | null; unit_identifier: string; property_name: string; our_number: string | null }>(
    `SELECT x.id, x.lease_id, x.description, to_char(x.due_date,'YYYY-MM-DD') AS due_date, x.amount_cents, x.paid_cents, x.tenant_names, x.unit_identifier, x.property_name,
            (SELECT b.our_number FROM boletos b WHERE b.charge_id = x.id AND b.status IN ('pendente','vencida') LIMIT 1) AS our_number
     FROM (${CHARGE_SELECT} WHERE c.organization_id = $1 AND c.cancelled_at IS NULL) x
     WHERE x.status IN ('aberta','parcial','vencida') ORDER BY x.due_date DESC LIMIT 800`,
    [orgId],
  );
  const memo = norm(line.memo);
  const scored = open
    .map((c) => {
      const left = c.amount_cents - c.paid_cents;
      let score = 0;
      const why: string[] = [];
      if (c.our_number && memo.includes(norm(c.our_number).trim()) && norm(c.our_number).trim().length >= 4) { score += 100; why.push("nosso número no histórico"); }
      if (left === line.amount_cents) { score += 50; why.push("valor igual ao saldo"); }
      else if (c.amount_cents === line.amount_cents) { score += 30; why.push("valor igual ao da cobrança"); }
      const tokens = norm(c.tenant_names ?? "").split(" ").filter((t) => t.length >= 4);
      const hits = tokens.filter((t) => memo.includes(t)).length;
      if (hits >= 2) { score += 35; why.push("nome do pagador"); } else if (hits === 1) { score += 12; why.push("parte do nome"); }
      const gap = Math.abs((Date.parse(c.due_date) - Date.parse(line.posted_at)) / 86_400_000);
      if (gap <= 10) score += 10 - Math.floor(gap / 2);
      return { ...c, balance_cents: left, score, why };
    })
    .filter((c) => c.score >= 30)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
  res.json({ items: scored });
});

/** Confirma: registra o pagamento (recibo e baixas) com a data do extrato e marca a linha como conciliada. */
bankRouter.post("/bank/lines/:id/reconcile", ...staff, async (req, res) => {
  const orgId = req.auth!.organization.id;
  const id = parseId(req.params.id);
  const leaseId = parseId(req.body?.lease_id);
  const raw = Array.isArray(req.body?.allocations) ? req.body.allocations : req.body?.charge_id ? [{ charge_id: req.body.charge_id }] : [];
  if (!id || !leaseId || raw.length === 0 || raw.length > 50) return void res.status(400).json({ error: "Informe lease_id e a(s) cobrança(s) a baixar." });
  const claimed = await db.query<{ amount_cents: number; posted_at: string }>(
    "UPDATE bank_lines SET status = 'conciliada' WHERE id = $1 AND organization_id = $2 AND status = 'pendente' AND amount_cents > 0 RETURNING amount_cents, to_char(posted_at,'YYYY-MM-DD') AS posted_at",
    [id, orgId],
  );
  const line = claimed[0];
  if (!line) return void res.status(409).json({ error: "Esta linha não está pendente (já conciliada, ignorada ou é um débito)." });
  const undo = () => db.query("UPDATE bank_lines SET status = 'pendente', payment_id = NULL WHERE id = $1", [id]);
  const allocations: { chargeId: number; amount: number }[] = [];
  let remaining = line.amount_cents;
  for (const a of raw as { charge_id: unknown; amount_cents?: unknown }[]) {
    const chargeId = parseId(a.charge_id);
    if (!chargeId) { await undo(); return void res.status(400).json({ error: "charge_id inválido" }); }
    let amount = Number.isInteger(a.amount_cents) ? (a.amount_cents as number) : 0;
    if (!amount) {
      // Sem valor informado: baixa o saldo da cobrança (ou o que sobrar do crédito).
      const [c] = await db.query<{ left: number }>(`SELECT (x.amount_cents - x.paid_cents) AS "left" FROM (${CHARGE_SELECT} WHERE c.organization_id = $1 AND c.id = $2) x`, [orgId, chargeId]);
      amount = Math.min(c?.left ?? 0, remaining);
    }
    if (amount < 1) { await undo(); return void res.status(409).json({ error: "Cobrança sem saldo em aberto." }); }
    allocations.push({ chargeId, amount });
    remaining -= amount;
  }
  const today = brToday();
  const outcome = await recordPayment(orgId, req.auth!.user.id, {
    leaseId,
    receivedAt: line.posted_at > today ? today : line.posted_at,
    amountCents: allocations.reduce((s, a) => s + a.amount, 0),
    method: req.body?.method === "boleto" ? "boleto" : req.body?.method === "pix" ? "pix" : "transferencia",
    reference: `Extrato bancário #${id}`,
    allocations,
  });
  if (outcome.code !== 201) { await undo(); return void res.status(outcome.code).json({ error: outcome.error }); }
  const sum = allocations.reduce((s, a) => s + a.amount, 0);
  if (sum !== line.amount_cents) {
    // O crédito é maior que as cobranças escolhidas: o pagamento cobre só o valor baixado; o resto fica anotado.
    await db.query("UPDATE bank_lines SET payment_id = $2, memo = memo || $3 WHERE id = $1", [id, outcome.payment.id, ` [conciliado ${sum / 100} de ${line.amount_cents / 100}]`]);
  } else {
    await db.query("UPDATE bank_lines SET payment_id = $2 WHERE id = $1", [id, outcome.payment.id]);
  }
  await db.query(
    `UPDATE boletos SET status = 'paga', paid_at = $2, payment_id = $3, updated_at = now()
     WHERE organization_id = $1 AND provider = 'manual' AND status IN ('pendente','vencida') AND charge_id = ANY($4::int[])`,
    [orgId, line.posted_at > today ? today : line.posted_at, outcome.payment.id, allocations.map((a) => a.chargeId)],
  );
  res.json({ payment: outcome.payment });
});

bankRouter.post("/bank/lines/:id/ignore", ...staff, async (req, res) => {
  const id = parseId(req.params.id);
  const done = id ? await db.query("UPDATE bank_lines SET status = 'ignorada' WHERE id = $1 AND organization_id = $2 AND status = 'pendente' RETURNING id", [id, req.auth!.organization.id]) : [];
  if (done.length === 0) return void res.status(404).json({ error: "Linha pendente não encontrada." });
  res.status(204).end();
});

bankRouter.post("/bank/lines/:id/restore", ...staff, async (req, res) => {
  const id = parseId(req.params.id);
  const done = id ? await db.query("UPDATE bank_lines SET status = 'pendente' WHERE id = $1 AND organization_id = $2 AND status = 'ignorada' AND amount_cents > 0 RETURNING id", [id, req.auth!.organization.id]) : [];
  if (done.length === 0) return void res.status(404).json({ error: "Linha ignorada não encontrada." });
  res.status(204).end();
});
