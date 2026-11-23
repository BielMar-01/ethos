import { Router } from "express";
import { requireAuth, requireRole } from "./auth.js";
import { RateLimiter } from "./ratelimit.js";

/**
 * Consulta de CEP para preencher endereços mais rápido.
 * O navegador NÃO chama serviços externos (a CSP só permite o próprio domínio e o CEP não deve vazar para terceiros
 * com o IP do usuário): ele chama esta rota, que consulta ViaCEP e, se estiver fora do ar, BrasilAPI.
 */

export interface CepResult {
  zip: string; // 00000-000
  street: string;
  neighborhood: string;
  city: string;
  state: string;
  complement: string;
}

const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE = 1000;
const cache = new Map<string, { at: number; value: CepResult | null }>();
const limiter = new RateLimiter(Number(process.env.CEP_RATE_MAX ?? 60), 60 * 1000);

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const format = (digits: string) => `${digits.slice(0, 5)}-${digits.slice(5)}`;

async function getJson(url: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(4000), headers: { Accept: "application/json" } });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function viaCep(digits: string): Promise<CepResult | null> {
  const { status, body } = await getJson(`https://viacep.com.br/ws/${digits}/json/`);
  if (status >= 500 || status === 429) throw new Error(`ViaCEP HTTP ${status}`);
  const b = (body ?? {}) as Record<string, unknown>;
  if (status >= 400 || b.erro) return null; // CEP inexistente
  return {
    zip: format(digits),
    street: str(b.logradouro),
    neighborhood: str(b.bairro),
    city: str(b.localidade),
    state: str(b.uf).toUpperCase(),
    complement: str(b.complemento),
  };
}

async function brasilApi(digits: string): Promise<CepResult | null> {
  const { status, body } = await getJson(`https://brasilapi.com.br/api/cep/v1/${digits}`);
  if (status === 404) return null;
  if (status >= 400) throw new Error(`BrasilAPI HTTP ${status}`);
  const b = (body ?? {}) as Record<string, unknown>;
  return { zip: format(digits), street: str(b.street), neighborhood: str(b.neighborhood), city: str(b.city), state: str(b.state).toUpperCase(), complement: "" };
}

/** Resolve um CEP (8 dígitos). `null` = não existe. Lança se nenhum provedor respondeu. */
export async function lookupCep(digits: string): Promise<CepResult | null> {
  const hit = cache.get(digits);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  let value: CepResult | null;
  try {
    value = await viaCep(digits);
    // ViaCEP às vezes não conhece CEPs novos que a BrasilAPI conhece.
    if (value === null) value = await brasilApi(digits).catch(() => null);
  } catch {
    value = await brasilApi(digits); // se também falhar, propaga
  }
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value!);
  cache.set(digits, { at: Date.now(), value });
  return value;
}

/** Só para testes. */
export function clearCepCache() {
  cache.clear();
}

export const cepRouter = Router();

cepRouter.get("/cep/:cep", requireAuth, requireRole("admin", "colaborador"), async (req, res) => {
  const digits = String(req.params.cep).replace(/\D/g, "");
  if (digits.length !== 8) {
    res.status(400).json({ error: "CEP inválido: informe 8 números." });
    return;
  }
  if (!limiter.allow(`cep:${req.auth!.organization.id}`)) {
    res.status(429).json({ error: "Muitas consultas de CEP. Aguarde um instante." });
    return;
  }
  try {
    const found = await lookupCep(digits);
    if (!found) {
      res.status(404).json({ error: "CEP não encontrado. Confira os números ou preencha o endereço manualmente." });
      return;
    }
    res.set("Cache-Control", "private, max-age=3600").json(found);
  } catch {
    res.status(502).json({ error: "Não foi possível consultar o CEP agora. Preencha o endereço manualmente." });
  }
});
