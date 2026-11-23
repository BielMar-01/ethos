import { closeDb, migrate } from "./db.js";

migrate()
  .then((ran) => console.log(ran.length ? `Aplicadas: ${ran.join(", ")}` : "Banco já está atualizado."))
  .catch((err) => {
    console.error("Falha na migração:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(closeDb);
