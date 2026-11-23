import crypto from "node:crypto";
import { Router } from "express";
import { db } from "./db.js";
import { hashApiKey, requireAuth, requireRole } from "./auth.js";
import { parseId } from "./crud.js";

/** Gestão das chaves de API (somente admin logado — uma chave não administra chaves). */
export const apiKeysRouter = Router();
apiKeysRouter.use("/api-keys", requireAuth, requireRole("admin"));

apiKeysRouter.get("/api-keys", async (req, res) => {
  const items = await db.query(
    `SELECT id, name, prefix, created_at, last_used_at, revoked_at FROM api_keys
     WHERE organization_id = $1 ORDER BY id DESC`,
    [req.auth!.organization.id],
  );
  res.json({ items });
});

apiKeysRouter.post("/api-keys", async (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (!name || name.length > 100) {
    res.status(400).json({ error: "Informe um nome para a chave (até 100 caracteres)" });
    return;
  }
  const [{ n }] = (await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM api_keys WHERE organization_id = $1 AND revoked_at IS NULL",
    [req.auth!.organization.id],
  )) as [{ n: number }];
  if (n >= 20) {
    res.status(409).json({ error: "Limite de 20 chaves ativas. Revogue alguma antes de criar outra." });
    return;
  }
  const token = `ethos_${crypto.randomBytes(32).toString("base64url")}`;
  const [item] = await db.query(
    `INSERT INTO api_keys (organization_id, name, prefix, token_hash, created_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, name, prefix, created_at`,
    [req.auth!.organization.id, name, token.slice(0, 14), hashApiKey(token), req.auth!.user.id],
  );
  // O valor completo só aparece nesta resposta; depois só o prefixo fica visível.
  res.status(201).json({ item, token });
});

apiKeysRouter.delete("/api-keys/:id", async (req, res) => {
  const id = parseId(req.params.id);
  const done = id
    ? await db.query(
        "UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND organization_id = $2 AND revoked_at IS NULL RETURNING id",
        [id, req.auth!.organization.id],
      )
    : [];
  if (done.length === 0) {
    res.status(404).json({ error: "Chave não encontrada ou já revogada" });
    return;
  }
  res.status(204).end();
});
