import { createApp } from "./app.js";
import { migrate } from "./db.js";

const port = Number(process.env.PORT ?? 3000);

async function main() {
  const ran = await migrate();
  if (ran.length) console.log(`Migrações aplicadas: ${ran.join(", ")}`);
  createApp().listen(port, () => {
    console.log(`Ethos rodando em http://localhost:${port}`);
  });
}

main().catch((err) => {
  console.error("Falha ao iniciar:", err instanceof Error ? err.message : err);
  process.exit(1);
});
