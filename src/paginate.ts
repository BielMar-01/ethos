/**
 * Paginação opcional das listagens: sem `page`/`per_page` a resposta continua sendo a lista inteira (compatível com quem já usa a API).
 * Com `page` (e opcionalmente `per_page`, padrão 50, máximo 200) a resposta traz também `total`, `page`, `per_page` e `pages`.
 */
export interface PageParams {
  page: number;
  perPage: number;
  offset: number;
}

export function pageParams(q: Record<string, unknown>): PageParams | null | "invalid" {
  if (q.page === undefined && q.per_page === undefined) return null;
  const page = q.page === undefined ? 1 : Number(q.page);
  const perPage = q.per_page === undefined ? 50 : Number(q.per_page);
  if (!Number.isInteger(page) || page < 1 || page > 100_000 || !Number.isInteger(perPage) || perPage < 1 || perPage > 200) return "invalid";
  return { page, perPage, offset: (page - 1) * perPage };
}

export const pageInfo = (p: PageParams, total: number) => ({ total, page: p.page, per_page: p.perPage, pages: Math.max(1, Math.ceil(total / p.perPage)) });
export const PAGE_ERROR = "page deve ser inteiro ≥ 1 e per_page de 1 a 200.";
