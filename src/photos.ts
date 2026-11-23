import express, { Router } from "express";
import { db } from "./db.js";
import { requireAuth, requireRole } from "./auth.js";
import { parseId } from "./crud.js";

/**
 * Fotos de chamados de manutenção e de itens de vistoria. Ficam no PostgreSQL (privadas: só saem por
 * rota autenticada). Se o volume crescer, trocar por armazenamento de objetos muda só este módulo.
 */
export const MAX_PHOTO_BYTES = 3 * 1024 * 1024;
const MAX_PER_REQUEST = 10;
const MAX_PER_ITEM = 5;

/** Lê o corpo binário de imagens. Outros tipos de conteúdo chegam com o corpo vazio e são recusados. */
export const rawImage = express.raw({ type: ["image/jpeg", "image/png", "image/webp"], limit: MAX_PHOTO_BYTES });

type ImageType = "image/jpeg" | "image/png" | "image/webp";

/** Tipo real pelo conteúdo ("magic bytes"); o Content-Type enviado pelo cliente não é confiável. */
export function detectImage(buf: Buffer): ImageType | undefined {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return undefined;
}

export type PhotoTarget = { maintenanceRequestId: number } | { inspectionItemId: number };

export async function storePhoto(
  orgId: number,
  userId: number | null,
  target: PhotoTarget,
  body: unknown,
): Promise<{ ok: true; id: number } | { ok: false; code: number; error: string }> {
  if (!Buffer.isBuffer(body) || body.length === 0) {
    return { ok: false, code: 400, error: "Envie a imagem (JPEG, PNG ou WebP, até 3 MB) no corpo da requisição" };
  }
  const type = detectImage(body);
  if (!type) return { ok: false, code: 400, error: "Arquivo não é uma imagem JPEG, PNG ou WebP válida" };

  const [col, id, max] =
    "maintenanceRequestId" in target
      ? (["maintenance_request_id", target.maintenanceRequestId, MAX_PER_REQUEST] as const)
      : (["inspection_item_id", target.inspectionItemId, MAX_PER_ITEM] as const);
  const [count] = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM photos WHERE ${col} = $1`, [id]);
  if (count!.n >= max) return { ok: false, code: 409, error: `Limite de ${max} fotos atingido` };

  const [row] = await db.query<{ id: number }>(
    `INSERT INTO photos (organization_id, ${col}, content_type, size_bytes, data, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [orgId, id, type, body.length, body, userId],
  );
  return { ok: true, id: row!.id };
}

export const photosRouter = Router();

interface PhotoContext {
  content_type: string;
  data: Uint8Array;
  kind: "manutencao" | "vistoria";
  unit_id: number;
  lease_id: number | null;
  inspection_status: string | null;
}

/** Quem pode ver: equipe da organização; cliente só pelo vínculo (e vistoria só depois de concluída). */
photosRouter.get("/photos/:id", requireAuth, async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id);
  const [photo] = id
    ? await db.query<PhotoContext>(
        `SELECT p.content_type, p.data,
                CASE WHEN p.maintenance_request_id IS NOT NULL THEN 'manutencao' ELSE 'vistoria' END AS kind,
                COALESCE(m.unit_id, i.unit_id) AS unit_id, COALESCE(m.lease_id, i.lease_id) AS lease_id,
                i.status AS inspection_status
         FROM photos p
         LEFT JOIN maintenance_requests m ON m.id = p.maintenance_request_id
         LEFT JOIN inspection_items ii ON ii.id = p.inspection_item_id
         LEFT JOIN inspections i ON i.id = ii.inspection_id
         WHERE p.id = $1 AND p.organization_id = $2`,
        [id, auth.organization.id],
      )
    : [];
  if (!photo) {
    res.status(404).json({ error: "Não encontrado" });
    return;
  }

  let allowed = auth.role === "admin" || auth.role === "colaborador";
  const visibleToClient = photo.kind === "manutencao" || photo.inspection_status === "concluida";
  if (!allowed && visibleToClient) {
    if (auth.role === "inquilino" && auth.tenantId && photo.lease_id) {
      const own = await db.query("SELECT 1 FROM lease_tenants WHERE lease_id = $1 AND tenant_id = $2", [photo.lease_id, auth.tenantId]);
      allowed = own.length > 0;
    } else if (auth.role === "proprietario" && auth.ownerId) {
      const own = await db.query(
        `SELECT 1 FROM units u JOIN property_owners po ON po.property_id = u.property_id
         WHERE u.id = $1 AND po.owner_id = $2`,
        [photo.unit_id, auth.ownerId],
      );
      allowed = own.length > 0;
    }
  }
  if (!allowed) {
    res.status(404).json({ error: "Não encontrado" }); // não revela que a foto existe
    return;
  }
  res.set({
    "Content-Type": photo.content_type,
    "Content-Disposition": "inline",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, max-age=3600",
  });
  res.send(Buffer.from(photo.data));
});

/** Remoção pela equipe; fotos de vistoria concluída não podem ser removidas (o laudo é imutável). */
photosRouter.delete("/photos/:id", requireAuth, requireRole("admin", "colaborador"), async (req, res) => {
  const id = parseId(req.params.id);
  const [photo] = id
    ? await db.query<{ inspection_status: string | null }>(
        `SELECT i.status AS inspection_status FROM photos p
         LEFT JOIN inspection_items ii ON ii.id = p.inspection_item_id
         LEFT JOIN inspections i ON i.id = ii.inspection_id
         WHERE p.id = $1 AND p.organization_id = $2`,
        [id, req.auth!.organization.id],
      )
    : [];
  if (!photo) {
    res.status(404).json({ error: "Não encontrado" });
    return;
  }
  if (photo.inspection_status && !["agendada", "em_andamento"].includes(photo.inspection_status)) {
    res.status(409).json({ error: "A vistoria está fechada; as fotos não podem ser removidas" });
    return;
  }
  await db.query("DELETE FROM photos WHERE id = $1", [id]);
  res.status(204).end();
});
