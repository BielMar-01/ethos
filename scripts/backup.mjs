// Backup lógico do banco (formato custom do pg_dump, compactado). Uso: npm run db:backup
// Requer o cliente do PostgreSQL (pg_dump) instalado e BACKUP_DATABASE_URL (conexão DIRETA ou "Session pooler" do Supabase,
// porta 5432; o "Transaction pooler" 6543 NÃO serve para pg_dump). Nunca coloque a URL no código: ela vem do .env.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

try {
  process.loadEnvFile(".env");
} catch {
  /* sem .env: usa o ambiente */
}
const url = process.env.BACKUP_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
  console.error("Defina BACKUP_DATABASE_URL (conexão direta ou Session pooler do Supabase) no .env.");
  process.exit(1);
}
if (/:6543\//.test(url)) {
  console.error("A URL usa o Transaction pooler (porta 6543). O pg_dump precisa da conexão direta ou do Session pooler (porta 5432).");
  process.exit(1);
}
const dir = process.env.BACKUP_DIR || "backups";
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
const file = path.join(dir, `ethos-${stamp}.dump`);
const r = spawnSync("pg_dump", ["--format=custom", "--compress=9", "--no-owner", "--no-privileges", "--file", file, url], { stdio: ["ignore", "inherit", "inherit"] });
if (r.error) {
  console.error("Não consegui executar o pg_dump:", r.error.message, "\nInstale o cliente do PostgreSQL (versão igual ou maior que a do servidor).");
  process.exit(1);
}
if (r.status !== 0) process.exit(r.status ?? 1);
const mb = (fs.statSync(file).size / 1024 / 1024).toFixed(2);
console.log(`Backup gerado: ${file} (${mb} MB).`);
console.log("Guarde uma cópia FORA desta máquina e teste a restauração (docs/BACKUP-RESTAURACAO.md).");

// Mantém só os N mais recentes (padrão 14).
const keep = Number(process.env.BACKUP_KEEP ?? 14);
const all = fs.readdirSync(dir).filter((f) => /^ethos-.*\.dump$/.test(f)).sort();
for (const old of all.slice(0, Math.max(0, all.length - keep))) fs.unlinkSync(path.join(dir, old));
