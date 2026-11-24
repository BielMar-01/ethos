import type { NextFunction, Request, Response } from "express";

/**
 * Proteção contra CSRF para quem usa cookie de sessão. Além do `SameSite=Lax` do cookie, toda escrita
 * (POST/PUT/PATCH/DELETE em /api) feita por um NAVEGADOR precisa vir do próprio site:
 *  - com `Origin`: o host tem de ser o do servidor (ou o de APP_URL);
 *  - sem `Origin` mas com `Sec-Fetch-Site`: só `same-origin` ou `none`.
 * Clientes que não são navegadores (curl, n8n, testes) não mandam nenhum dos dois e passam: CSRF só existe
 * porque o navegador anexa o cookie sozinho. Chaves de API (Authorization: Bearer) não usam cookie e ficam de fora.
 */
const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

const hostOf = (value: string): string | null => {
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
};

export function csrfGuard(req: Request, res: Response, next: NextFunction): void {
  if (SAFE.has(req.method) || req.headers.authorization?.startsWith("Bearer ethos_")) return next();
  const origin = req.get("origin");
  let ok = true;
  if (origin && origin !== "null") {
    const allowed = new Set([req.get("host")?.toLowerCase(), hostOf(process.env.APP_URL ?? "http://localhost:5173")].filter(Boolean));
    const host = hostOf(origin);
    ok = !!host && allowed.has(host);
  } else if (origin === "null") {
    ok = false;
  } else {
    const site = req.get("sec-fetch-site");
    ok = !site || site === "same-origin" || site === "none";
  }
  if (!ok) {
    res.status(403).json({ error: "Requisição bloqueada: origem não permitida." });
    return;
  }
  next();
}
