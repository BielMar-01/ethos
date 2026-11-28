-- Documentos que já existem, anexados a um contrato (o arquivo original, privado), e modelo padrão dos próximos contratos.

CREATE TABLE lease_files (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lease_id integer NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('contrato','aditivo','vistoria','garantia','distrato','outro')),
  title text NOT NULL,
  content_type text NOT NULL,
  size_bytes integer NOT NULL,
  -- Impressão digital do arquivo: evita anexar duas vezes o mesmo no mesmo contrato.
  sha256 text NOT NULL,
  data bytea NOT NULL,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (lease_id, sha256)
);
CREATE INDEX ON lease_files (organization_id);
ALTER TABLE lease_files ENABLE ROW LEVEL SECURITY;

ALTER TABLE contract_templates ADD COLUMN is_default boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX contract_templates_one_default ON contract_templates (organization_id) WHERE is_default;
