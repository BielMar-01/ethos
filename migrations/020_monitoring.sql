-- Monitoramento de erros do próprio sistema (servidor e navegador). Sem corpo de requisição, sem dados pessoais.
CREATE TABLE error_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer REFERENCES organizations(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('server','client')),
  message text NOT NULL,
  stack text,
  method text,
  path text,
  status integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX error_logs_recent ON error_logs (created_at DESC);
CREATE INDEX error_logs_org ON error_logs (organization_id, id DESC);
ALTER TABLE error_logs ENABLE ROW LEVEL SECURITY;
