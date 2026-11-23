-- Registro de auditoria: quem fez o quê, quando e de onde. Só o administrador da organização lê.
-- Append-only por desenho: o aplicativo só insere e consulta (não há rota de edição nem de exclusão).
-- O nome e o e-mail do autor são copiados para a linha, para o histórico sobreviver à remoção do usuário.

CREATE TABLE audit_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id integer REFERENCES users(id) ON DELETE SET NULL,
  user_name text,
  user_email text,
  role text,
  kind text NOT NULL CHECK (kind IN ('create','update','delete','action','auth','denied','system')),
  entity text,                         -- recurso afetado (leases, charges, members…)
  entity_id integer,
  summary text NOT NULL,               -- frase pronta em português para leitura humana
  status integer,                      -- código HTTP da resposta
  metadata jsonb NOT NULL DEFAULT '{}',
  ip text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_logs_org_time ON audit_logs (organization_id, id DESC);
CREATE INDEX audit_logs_org_user ON audit_logs (organization_id, user_id, id DESC);
CREATE INDEX audit_logs_org_entity ON audit_logs (organization_id, entity, id DESC);

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
