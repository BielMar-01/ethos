/**
 * Uso: npm run seed:demo -- <e-mail-do-admin>
 * Popula a organização desse administrador com dados FICTÍCIOS de demonstração.
 * Só funciona em organização sem imóveis (nunca sobrescreve dados reais).
 */
import { closeDb, db } from "../db.js";
import { seedDemo } from "../demo.js";

async function main() {
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email) {
    console.error("Informe o e-mail do administrador: npm run seed:demo -- admin@exemplo.com");
    process.exitCode = 1;
    return;
  }
  const [row] = await db.query<{ organization_id: number; user_id: number; organization: string }>(
    `SELECT m.organization_id, m.user_id, o.name AS organization
     FROM organization_members m
     JOIN users u ON u.id = m.user_id
     JOIN organizations o ON o.id = m.organization_id
     WHERE u.email = $1 AND m.role = 'admin' ORDER BY m.id LIMIT 1`,
    [email],
  );
  if (!row) {
    console.error("Nenhum administrador com esse e-mail.");
    process.exitCode = 1;
    return;
  }
  console.log(`Populando a organização "${row.organization}" com dados de demonstração…`);
  const s = await seedDemo(row.organization_id, row.user_id);
  console.log(
    `Criados: ${s.owners} proprietários, ${s.properties} imóveis, ${s.units} unidades, ${s.tenants} inquilinos, ` +
      `${s.leases} contratos, ${s.charges} cobranças, ${s.payments} pagamentos, ${s.transfers} repasses.`,
  );
  console.log("\nConvites para testar a área do cliente (use um e-mail seu ao aceitar, se preferir criar outro convite):");
  for (const i of s.invites) console.log(`  ${i.label}: ${i.link}`);
}

main()
  .catch((err) => {
    console.error("Falha:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(closeDb);
