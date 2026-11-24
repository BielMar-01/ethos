import { Router } from "express";
import { db } from "./db.js";
import { requireAuth, requireRole } from "./auth.js";
import { CHARGE_SELECT, brToday } from "./finance.js";
import { notify, tenantUsersOfLease } from "./notifications.js";
import { formatBRL } from "./contractTemplate.js";
import { periodicJobs } from "./reminders.js";

/**
 * Multa e juros de mora automáticos. Regras (configuráveis em Financeiro > Configurações):
 *  - multa única: `late_fee_bps` sobre o saldo em aberto, uma vez por cobrança vencida (depois da carência);
 *  - juros: `late_interest_bps` sobre o saldo, a cada bloco de 30 dias de atraso (bloco 1 aos 30 dias, bloco 2 aos 60…).
 * Nascem como cobranças filhas (kind multa/juros, parent_charge_id) e seguem o fluxo normal (boleto, pagamento, recibo).
 * Idempotente: um índice único impede repetir a mesma multa/bloco. NUNCA altera uma cobrança existente.
 * É um cálculo SIMPLES e configurável; confira se ele corresponde ao que o contrato de cada cliente prevê.
 */

const BASES = ["aluguel", "taxa", "outro"];
const MAX_BLOCKS = 24;
const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);

export interface LateFeeResult {
  fees: number;
  interests: number;
  amountCents: number;
}

export async function applyLateFees(orgId: number, opts: { today?: string; dryRun?: boolean; userId?: number | null } = {}): Promise<LateFeeResult> {
  const today = opts.today ?? brToday();
  const [cfg] = await db.query<{ late_fee_bps: number; late_interest_bps: number; late_grace_days: number }>(
    "SELECT late_fee_bps, late_interest_bps, late_grace_days FROM organizations WHERE id = $1",
    [orgId],
  );
  const out: LateFeeResult = { fees: 0, interests: 0, amountCents: 0 };
  if (!cfg || (cfg.late_fee_bps === 0 && cfg.late_interest_bps === 0)) return out;

  const parents = await db.query<{ id: number; lease_id: number; description: string; competence: string; amount_cents: number; paid_cents: number; due_date: string }>(
    `SELECT x.id, x.lease_id, x.description, to_char(x.competence, 'YYYY-MM-DD') AS competence, x.amount_cents, x.paid_cents, to_char(x.due_date, 'YYYY-MM-DD') AS due_date
     FROM (${CHARGE_SELECT} WHERE c.organization_id = $1 AND c.cancelled_at IS NULL AND c.parent_charge_id IS NULL AND c.kind = ANY($2::text[])) x
     WHERE x.status = 'vencida' ORDER BY x.id`,
    [orgId, BASES],
  );
  for (const p of parents) {
    const days = dayDiff(today, p.due_date);
    if (days <= cfg.late_grace_days) continue;
    const open = p.amount_cents - p.paid_cents;
    if (open <= 0) continue;
    const wanted: { kind: "multa" | "juros"; block: number; amount: number; description: string }[] = [];
    if (cfg.late_fee_bps > 0) {
      wanted.push({ kind: "multa", block: 0, amount: Math.max(1, Math.round((open * cfg.late_fee_bps) / 10000)), description: `Multa por atraso (${cfg.late_fee_bps / 100}%) — ${p.description}` });
    }
    if (cfg.late_interest_bps > 0) {
      for (let k = 1; k <= Math.min(Math.floor(days / 30), MAX_BLOCKS); k++) {
        wanted.push({ kind: "juros", block: k, amount: Math.max(1, Math.round((open * cfg.late_interest_bps) / 10000)), description: `Juros de mora (${cfg.late_interest_bps / 100}% a cada 30 dias, ${k}º período) — ${p.description}` });
      }
    }
    let created = 0;
    let createdAmount = 0;
    for (const w of wanted) {
      if (opts.dryRun) {
        const exists = await db.query("SELECT 1 FROM charges WHERE parent_charge_id = $1 AND kind = $2 AND late_block = $3 AND cancelled_at IS NULL", [p.id, w.kind, w.block]);
        if (exists.length === 0) {
          w.kind === "multa" ? out.fees++ : out.interests++;
          out.amountCents += w.amount;
        }
        continue;
      }
      const r = await db.query(
        `INSERT INTO charges (organization_id, lease_id, kind, description, competence, due_date, amount_cents, parent_charge_id, late_block, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (parent_charge_id, kind, late_block) WHERE parent_charge_id IS NOT NULL AND cancelled_at IS NULL DO NOTHING
         RETURNING id`,
        [orgId, p.lease_id, w.kind, w.description.slice(0, 250), p.competence, today, w.amount, p.id, w.block, opts.userId ?? null],
      );
      if (r.length > 0) {
        w.kind === "multa" ? out.fees++ : out.interests++;
        out.amountCents += w.amount;
        created++;
        createdAmount += w.amount;
      }
    }
    if (created > 0) {
      await notify(orgId, await tenantUsersOfLease(p.lease_id), {
        category: "financeiro",
        kind: "late_fee",
        title: "Encargos por atraso",
        body: `${formatBRL(createdAmount)} de multa/juros sobre "${p.description}". Regularize para evitar novos encargos.`,
        linkKind: "charge",
        linkId: p.id,
      });
    }
  }
  return out;
}

export const lateFeesRouter = Router();
lateFeesRouter.use("/charges/late-fees", requireAuth, requireRole("admin"));

/** Aplica agora (ou, com dry_run, só calcula o que seria criado). Também roda sozinho junto com os lembretes. */
lateFeesRouter.post("/charges/late-fees/run", async (req, res) => {
  res.json(await applyLateFees(req.auth!.organization.id, { dryRun: req.body?.dry_run === true, userId: req.auth!.user.id }));
});

periodicJobs.push({
  name: "multa e juros por atraso",
  run: async () => {
    const orgs = await db.query<{ id: number }>("SELECT id FROM organizations WHERE late_fee_bps > 0 OR late_interest_bps > 0");
    for (const o of orgs) await applyLateFees(o.id).catch((err) => console.error(`Multa/juros da organização ${o.id} falhou:`, err instanceof Error ? err.message : err));
  },
});
