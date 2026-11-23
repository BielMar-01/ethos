/**
 * Executa uma tarefa DEPOIS de responder ao cliente (auditoria, webhooks).
 * Na Vercel o processo pode ser congelado assim que a resposta termina; `waitUntil` mantém a função viva até a tarefa acabar.
 * Fora da Vercel (servidor comum, testes) basta deixar a promessa rodar.
 */
export function background(task: Promise<unknown>): void {
  const safe = task.catch((err) => console.error("Tarefa em segundo plano falhou:", err instanceof Error ? err.message : err));
  if (process.env.VERCEL) {
    import("@vercel/functions").then((m) => m.waitUntil(safe)).catch(() => {});
  }
}
