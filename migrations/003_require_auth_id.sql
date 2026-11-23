-- Conclui a migração de credenciais. Falha se houver usuário sem conta no Supabase Auth:
-- rode `npm run user:reset-password -- <email>` para cada um (cria a conta e vincula).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM users WHERE auth_id IS NULL) THEN
    RAISE EXCEPTION 'Há usuários sem auth_id. Rode: npm run user:reset-password -- <email> para cada um e aplique a migração de novo.';
  END IF;
END $$;

ALTER TABLE users ALTER COLUMN auth_id SET NOT NULL;
ALTER TABLE users DROP COLUMN password_hash;
