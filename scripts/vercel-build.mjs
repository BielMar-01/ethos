// Build na Vercel: compila servidor e interface; em PRODUÇÃO aplica as migrações pendentes no banco.
// (Previews não tocam o banco: use um banco separado para elas, se quiser migrá-las.)
import { spawnSync } from 'node:child_process'

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

run('npm', ['run', 'build'])

if (process.env.VERCEL_ENV === 'production') {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL não definida no ambiente de Production da Vercel.')
    process.exit(1)
  }
  run('npm', ['run', 'db:migrate'])
} else {
  console.log(`Migrações puladas (VERCEL_ENV=${process.env.VERCEL_ENV ?? 'local'}).`)
}
