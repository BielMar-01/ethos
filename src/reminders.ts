import { Router } from "express";
import { db } from "./db.js";
import { requireAuth, requireRole } from "./auth.js";
import { CHARGE_SELECT } from "./finance.js";
import { formatBRL, formatDate } from "./contractTemplate.js";
import { notify, staffUsers, tenantUsersOfLease } from "./notifications.js";

const DUE_SOON_DAYS = 3;
const LEASE_ENDING_DAYS = 60;
const BR_TODAY = "(now() AT TIME ZONE 'America/Sao_Paulo')::date";

export interface ReminderResult {
  dueSoon: number;
  overdue: number;
  overdueDigest: number;
  leasesEnding: number;
}

/**
 * Gera lembretes de UMA organização. Idempotente: a `dedupe_key` impede repetir o aviso para a mesma
 * pessoa, então pode rodar quantas vezes for (agendado ou manualmente).
 */
export async function runReminders(orgId: number): Promise<ReminderResult> {
  const result: ReminderResult = { dueSoon: 0, overdue: 0, overdueDigest: 0, leasesEnding: 0 };

  // Cobranças a vencer nos próximos dias → inquilino
  const soon = await db.query<{ id: number; lease_id: number; description: string; amount_cents: number; paid_cents: number; due_date: string }>(
    `SELECT x.id, x.lease_id, x.description, x.amount_cents, x.paid_cents, x.due_date
     FROM (${CHARGE_SELECT} WHERE c.organization_id = $1 AND c.cancelled_at IS NULL) x
     WHERE x.status IN ('aberta','parcial') AND x.due_date <= ${BR_TODAY} + ${DUE_SOON_DAYS}`,
    [orgId],
  );
  for (const c of soon) {
    result.dueSoon += await notify(orgId, await tenantUsersOfLease(c.lease_id), {
      category: "financeiro",
      kind: "charge_due_soon",
      title: "Cobrança vence em breve",
      body: `${c.description} · ${formatBRL(c.amount_cents - c.paid_cents)} · vence em ${formatDate(c.due_date)}`,
      linkKind: "charge",
      linkId: c.id,
      dedupeKey: `due-soon:${c.id}`,
    });
  }

  // Cobranças vencidas → inquilino (uma vez por cobrança) e resumo diário para os administradores
  const late = await db.query<{ id: number; lease_id: number; description: string; amount_cents: number; paid_cents: number; due_date: string }>(
    `SELECT x.id, x.lease_id, x.description, x.amount_cents, x.paid_cents, x.due_date
     FROM (${CHARGE_SELECT} WHERE c.organization_id = $1 AND c.cancelled_at IS NULL) x
     WHERE x.status = 'vencida'`,
    [orgId],
  );
  for (const c of late) {
    result.overdue += await notify(orgId, await tenantUsersOfLease(c.lease_id), {
      category: "financeiro",
      kind: "charge_overdue",
      title: "Cobrança em atraso",
      body: `${c.description} · ${formatBRL(c.amount_cents - c.paid_cents)} · venceu em ${formatDate(c.due_date)}`,
      linkKind: "charge",
      linkId: c.id,
      dedupeKey: `overdue:${c.id}`,
    });
  }
  if (late.length > 0) {
    const total = late.reduce((s, c) => s + c.amount_cents - c.paid_cents, 0);
    const [today] = await db.query<{ d: string }>(`SELECT ${BR_TODAY}::text AS d`);
    result.overdueDigest = await notify(orgId, await staffUsers(orgId), {
      category: "financeiro",
      kind: "overdue_digest",
      title: `${late.length} cobrança(s) em atraso`,
      body: `Total em aberto: ${formatBRL(total)}`,
      linkKind: "charge",
      dedupeKey: `overdue-digest:${today!.d}`,
    });
  }

  // Contratos vigentes perto do fim → administradores
  const ending = await db.query<{ id: number; end_date: string; unit_identifier: string; property_name: string }>(
    `SELECT l.id, l.end_date, u.identifier AS unit_identifier, p.name AS property_name
     FROM leases l JOIN units u ON u.id = l.unit_id JOIN properties p ON p.id = u.property_id
     WHERE l.organization_id = $1 AND l.status = 'vigente'
       AND l.end_date >= ${BR_TODAY} AND l.end_date <= ${BR_TODAY} + ${LEASE_ENDING_DAYS}`,
    [orgId],
  );
  for (const l of ending) {
    result.leasesEnding += await notify(orgId, await staffUsers(orgId), {
      category: "contrato",
      kind: "lease_ending",
      title: "Contrato próximo do fim",
      body: `${l.property_name} · ${l.unit_identifier} termina em ${formatDate(l.end_date)}`,
      linkKind: "lease",
      linkId: l.id,
      dedupeKey: `lease-ending:${l.id}:${l.end_date}`,
    });
  }
  return result;
}

/** Remove notificações antigas (lidas há mais de 30 dias ou qualquer uma com mais de 180). */
export async function pruneNotifications(): Promise<void> {
  await db.query(
    "DELETE FROM notifications WHERE created_at < now() - interval '180 days' OR (read_at IS NOT NULL AND read_at < now() - interval '30 days')",
  );
}

/** Roda para todas as organizações. Falha de uma não impede as demais. */
export async function runAllReminders(): Promise<void> {
  const orgs = await db.query<{ id: number }>("SELECT id FROM organizations");
  for (const o of orgs) {
    try {
      await runReminders(o.id);
    } catch (err) {
      console.error(`Lembretes da organização ${o.id} falharam:`, err instanceof Error ? err.message : err);
    }
  }
  await pruneNotifications().catch((err) => console.error("Limpeza de notificações falhou:", err));
}

/**
 * Agenda os lembretes neste processo (a cada 6 h). Em hospedagem sem processo contínuo (serverless),
 * use um agendador externo chamando POST /api/reminders/run.
 */
export function startReminderJob(): NodeJS.Timeout {
  const first = setTimeout(() => void runAllReminders(), 30_000);
  first.unref();
  const timer = setInterval(() => void runAllReminders(), 6 * 60 * 60 * 1000);
  timer.unref();
  return timer;
}

export const remindersRouter = Router();
remindersRouter.post("/reminders/run", requireAuth, requireRole("admin"), async (req, res) => {
  res.json(await runReminders(req.auth!.organization.id));
});
