# Backup e restauração

O banco é o PostgreSQL do Supabase. Os dados do Ethos (contratos, cobranças, recibos, fotos e documentos em `bytea`) estão todos nele.
Há **três camadas**; use ao menos as duas primeiras.

## 1. Backups do próprio Supabase (a base)
- Planos pagos (Pro em diante) têm **backup diário** automático (7 dias de retenção no Pro).
- **PITR** (recuperação a qualquer momento) é um complemento pago: ative em *Project Settings → Add-ons → Point in Time Recovery* se perder 1 dia de dados for inaceitável.
- No plano gratuito **não há backup diário**: faça a camada 2 pelo menos uma vez por dia.
- Restaurar: *Database → Backups → Restore* (substitui o banco atual; faça um backup lógico antes).

## 2. Backup lógico com o projeto (`npm run db:backup`)
Gera `backups/ethos-AAAAMMDD-HHMMSS.dump` (formato custom do `pg_dump`, compactado) e guarda os 14 mais recentes.

Pré-requisitos:
1. Cliente do PostgreSQL instalado (`pg_dump --version`), de versão **igual ou maior** que a do servidor (Supabase: Settings → Infrastructure).
2. No `.env`: `BACKUP_DATABASE_URL` com a conexão **direta** (`db.<ref>.supabase.co:5432`) ou o **Session pooler** (porta 5432). O Transaction pooler (6543) não funciona com `pg_dump`.
3. A pasta `backups/` está no `.gitignore` (o dump contém dados pessoais: **nunca** vá para o Git).

Automatizar (Windows): *Agendador de Tarefas* → ação `npm run db:backup` na pasta do projeto, 1×/dia. Depois copie o arquivo para fora da máquina (nuvem privada criptografada). Outra opção: GitHub Actions agendado com o segredo `BACKUP_DATABASE_URL` enviando o dump para um armazenamento privado.

> O script foi escrito mas **não foi executado** no ambiente de desenvolvimento (sem `pg_dump` instalado). Rode uma vez e confira.

## 3. Teste de restauração (faça todo mês)
Um backup que nunca foi restaurado é uma esperança, não um backup.
1. Crie um banco de teste vazio (outro projeto Supabase gratuito, ou PostgreSQL local).
2. `pg_restore --no-owner --no-privileges --clean --if-exists --dbname "<URL do banco de teste>" backups/ethos-….dump`
3. Aponte um `.env` de teste para esse banco e rode `npm run db:migrate` (não deve aplicar nada novo) e `npm start`.
4. Entre com um usuário e confira: contagem de imóveis/contratos/cobranças, um recibo antigo e uma foto.
5. Registre a data do teste e o tempo que levou (isso é o seu RTO real).

## O que NÃO está no banco
- Variáveis de ambiente (Vercel): guarde uma cópia **cifrada** (especialmente `INTEGRATIONS_SECRET`: sem ela, as chaves do Asaas/IA/webhooks e o 2FA gravados no banco ficam ilegíveis).
- Código: GitHub.

## Em caso de incidente
1. Pare as escritas (modo de manutenção/pausa do deploy) se houver corrupção.
2. Restaure o backup mais recente **em um banco novo**, valide, e só então troque `DATABASE_URL` na Vercel.
3. Reexecute `npm run db:migrate` e informe os usuários do horário até o qual os dados foram recuperados.
