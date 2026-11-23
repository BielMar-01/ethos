-- Área do cliente: o acesso de um inquilino/proprietário é VINCULADO ao cadastro dele
-- (tenants/owners), e é só por esse vínculo que ele enxerga dados.
ALTER TABLE organization_members
  ADD COLUMN tenant_id integer REFERENCES tenants(id) ON DELETE SET NULL,
  ADD COLUMN owner_id integer REFERENCES owners(id) ON DELETE SET NULL,
  ADD CONSTRAINT member_link_matches_role CHECK (
    (tenant_id IS NULL OR role = 'inquilino') AND (owner_id IS NULL OR role = 'proprietario')
  );

ALTER TABLE invitations
  ADD COLUMN tenant_id integer REFERENCES tenants(id) ON DELETE CASCADE,
  ADD COLUMN owner_id integer REFERENCES owners(id) ON DELETE CASCADE,
  ADD CONSTRAINT invitation_link_matches_role CHECK (
    (tenant_id IS NULL OR role = 'inquilino') AND (owner_id IS NULL OR role = 'proprietario')
  );

-- Chaves de API para integrações (somente leitura). Só o hash é guardado; o valor completo
-- é exibido uma única vez, na criação.
CREATE TABLE api_keys (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  prefix text NOT NULL,                 -- primeiros caracteres, para o admin reconhecer a chave
  token_hash text NOT NULL UNIQUE,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

CREATE INDEX ON api_keys (organization_id);
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
