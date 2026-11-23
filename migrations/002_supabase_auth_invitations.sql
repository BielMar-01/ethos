-- Credenciais passam a ser do Supabase Auth. Esta etapa só ADICIONA o vínculo (auth_id,
-- opcional por enquanto) para permitir migrar contas existentes; a 003 torna-o obrigatório.
ALTER TABLE users ADD COLUMN auth_id uuid UNIQUE;
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

-- Convites: o token em texto puro só existe no link entregue ao admin; aqui fica o hash.
CREATE TABLE invitations (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin','colaborador','proprietario','inquilino')),
  token_hash text NOT NULL UNIQUE,
  invited_by integer REFERENCES users(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- No máximo um convite pendente por e-mail em cada organização.
CREATE UNIQUE INDEX invitations_pending_email
  ON invitations (organization_id, email) WHERE accepted_at IS NULL;

ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
