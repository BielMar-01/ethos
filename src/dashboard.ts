import { Router } from "express";
import { db } from "./db.js";
import { requireAuth, requireRole } from "./auth.js";
import { financeSummary } from "./finance.js";

export const dashboardRouter = Router();

/** Visão geral da operação (mês atual, no fuso de Brasília). Tudo escopado pela organização da sessão. */
dashboardRouter.get("/dashboard", requireAuth, requireRole("admin", "colaborador"), async (req, res) => {
  const orgId = req.auth!.organization.id;
  const [{ month, today }] = (await db.query<{ month: string; today: string }>(
    "SELECT to_char((now() AT TIME ZONE 'America/Sao_Paulo'), 'YYYY-MM') AS month, ((now() AT TIME ZONE 'America/Sao_Paulo')::date)::text AS today",
  )) as [{ month: string; today: string }];

  const [counts] = await db.query<Record<string, number>>(
    `SELECT
       (SELECT count(*)::int FROM properties WHERE organization_id = $1) AS properties,
       (SELECT count(*)::int FROM owners WHERE organization_id = $1) AS owners,
       (SELECT count(*)::int FROM tenants WHERE organization_id = $1) AS tenants,
       (SELECT count(*)::int FROM units WHERE organization_id = $1) AS units_total,
       (SELECT count(*)::int FROM units WHERE organization_id = $1 AND status = 'ocupada') AS units_occupied,
       (SELECT count(*)::int FROM units WHERE organization_id = $1 AND status = 'disponivel') AS units_available,
       (SELECT count(*)::int FROM leases WHERE organization_id = $1 AND status = 'vigente') AS leases_active,
       (SELECT count(*)::int FROM leases WHERE organization_id = $1 AND status = 'vigente'
          AND end_date >= $2::date AND end_date <= $2::date + 60) AS leases_ending,
       (SELECT count(*)::int FROM maintenance_requests WHERE organization_id = $1 AND status NOT IN ('concluida','cancelada')) AS maintenance_open,
       (SELECT count(*)::int FROM maintenance_requests WHERE organization_id = $1 AND status NOT IN ('concluida','cancelada') AND priority = 'urgente') AS maintenance_urgent,
       (SELECT count(*)::int FROM maintenance_requests WHERE organization_id = $1 AND status = 'aguardando_aprovacao') AS maintenance_waiting,
       (SELECT count(*)::int FROM inspections WHERE organization_id = $1 AND status IN ('agendada','em_andamento')) AS inspections_pending`,
    [orgId, today],
  );
  const c = counts!;

  // Itens que pedem atenção agora, do mais urgente para o menos.
  const attention = await db.query<{ kind: string; title: string; detail: string; link_kind: string; link_id: number }>(
    `(SELECT 'maintenance' AS kind, m.title, p.name || ' · ' || u.identifier AS detail, 'maintenance' AS link_kind, m.id AS link_id, 0 AS rank
        FROM maintenance_requests m JOIN units u ON u.id = m.unit_id JOIN properties p ON p.id = u.property_id
        WHERE m.organization_id = $1 AND m.status NOT IN ('concluida','cancelada') AND m.priority = 'urgente'
        ORDER BY m.created_at LIMIT 3)
     UNION ALL
     (SELECT 'maintenance', m.title, 'Aguardando aprovação de orçamento', 'maintenance', m.id, 1
        FROM maintenance_requests m WHERE m.organization_id = $1 AND m.status = 'aguardando_aprovacao' ORDER BY m.updated_at LIMIT 3)
     UNION ALL
     (SELECT 'inspection', 'Vistoria de ' || i.type || ' prevista', p.name || ' · ' || u.identifier || ' — ' || to_char(i.scheduled_for, 'DD/MM/YYYY'), 'inspection', i.id, 2
        FROM inspections i JOIN units u ON u.id = i.unit_id JOIN properties p ON p.id = u.property_id
        WHERE i.organization_id = $1 AND i.status IN ('agendada','em_andamento') ORDER BY i.scheduled_for LIMIT 3)
     ORDER BY rank`,
    [orgId],
  );

  res.json({
    month,
    counts: {
      properties: c.properties, owners: c.owners, tenants: c.tenants,
      units: { total: c.units_total, occupied: c.units_occupied, available: c.units_available },
      leases: { active: c.leases_active, ending_60d: c.leases_ending },
      maintenance: { open: c.maintenance_open, urgent: c.maintenance_urgent, waiting_approval: c.maintenance_waiting },
      inspections_pending: c.inspections_pending,
    },
    finance: await financeSummary(orgId, month),
    attention: attention.map(({ kind, title, detail, link_kind, link_id }) => ({ kind, title, detail, link_kind, link_id })),
  });
});
