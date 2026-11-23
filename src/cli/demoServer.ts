/**
 * Modo demonstração: app COMPLETO em memória (Postgres em memória + identidade em memória),
 * já populado com dados fictícios e com logins prontos. Não toca no Supabase nem grava nada.
 *
 *   npm run build && npm run demo      → http://localhost:3100
 */
// Precisa vir antes de qualquer import que leia o ambiente (por isso os imports são dinâmicos).
process.env.ETHOS_DB = "memory";
process.env.REGISTER_RATE_MAX = "1000";

const PASSWORD = "demo-1234-senha";

async function main() {
  const { migrate } = await import("../db.js");
  const { createApp } = await import("../app.js");
  const { seedDemo } = await import("../demo.js");
  await migrate();

  const port = Number(process.env.PORT ?? 3100);
  process.env.APP_URL = `http://localhost:${port}`;
  const server = createApp().listen(port);
  const base = `http://localhost:${port}`;

  const post = async (path: string, body: unknown) => {
    const res = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json();
    if (!res.ok) throw new Error(`${path}: ${json.error}`);
    return json;
  };

  const admin = await post("/api/auth/register", {
    name: "Ana Administradora",
    email: "admin@demo.test",
    password: PASSWORD,
    organizationName: "Ethos Demonstração",
  });
  const summary = await seedDemo(admin.organization.id, admin.user.id);

  // Aceita os convites de demonstração para já existirem os logins de cliente.
  for (const [i, name] of [[0, "Carlos Almeida"], [1, "Maria Souza"]] as const) {
    const token = new URL(summary.invites[i]!.link).searchParams.get("invite");
    await post(`/api/invitations/by-token/${token}/accept`, { name, password: PASSWORD });
  }

  // Com os clientes já existentes: um comunicado de boas-vindas e os lembretes automáticos,
  // para os sinos de notificação já abrirem com conteúdo.
  const login = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin@demo.test", password: PASSWORD }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
  const asAdmin = async (path: string, body?: unknown) => {
    const res = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    return res.json();
  };
  const welcome = await asAdmin("/api/announcements", {
    title: "Bem-vindo(a) à área do cliente",
    body: "Aqui você acompanha cobranças, recibos, contrato, vistorias e pode abrir solicitações de manutenção.",
    audience: "todos",
  });
  await asAdmin(`/api/announcements/${welcome.id}/publish`);
  await asAdmin("/api/reminders/run");

  console.log(`\nEthos (DEMO em memória) em ${base}\n`);
  console.log("Logins (senha de todos: " + PASSWORD + "):");
  console.log("  Administrador: admin@demo.test");
  console.log("  Inquilino:     demo.inquilino@example.com     (Carlos Almeida)");
  console.log("  Proprietário:  demo.proprietario@example.com  (Maria Souza)");
  console.log("\nTudo é descartado ao encerrar (Ctrl+C).");

  process.on("SIGINT", () => server.close(() => process.exit(0)));
}

main().catch((err) => {
  console.error("Falha ao iniciar a demonstração:", err instanceof Error ? err.message : err);
  process.exit(1);
});
