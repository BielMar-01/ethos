-- Contratos: tipos de modelo, qualificação das partes, dados da administradora, número do documento e identidade visual.

-- Qualificação das partes (opcional no cadastro; exigida só quando o modelo usa).
ALTER TABLE owners ADD COLUMN nationality text, ADD COLUMN marital_status text, ADD COLUMN profession text, ADD COLUMN rg text,
  ADD COLUMN address text, ADD COLUMN spouse_name text, ADD COLUMN spouse_document text,
  ADD COLUMN representative_name text, ADD COLUMN representative_document text;
ALTER TABLE tenants ADD COLUMN nationality text, ADD COLUMN marital_status text, ADD COLUMN profession text, ADD COLUMN rg text,
  ADD COLUMN address text, ADD COLUMN spouse_name text, ADD COLUMN spouse_document text,
  ADD COLUMN representative_name text, ADD COLUMN representative_document text;

ALTER TABLE units ADD COLUMN registration_number text, ADD COLUMN iptu_number text, ADD COLUMN energy_installation text, ADD COLUMN water_supply text;

ALTER TABLE leases ADD COLUMN adjust_index text, ADD COLUMN signing_city text,
  ADD COLUMN witness1_name text, ADD COLUMN witness1_document text, ADD COLUMN witness2_name text, ADD COLUMN witness2_document text;

-- Dados da administradora (cabeçalho, rodapé e variáveis). O logo é uma data URI pequena (PNG/JPEG/WebP).
ALTER TABLE organizations ADD COLUMN legal_name text, ADD COLUMN cnpj text, ADD COLUMN creci text, ADD COLUMN company_address text,
  ADD COLUMN company_city text, ADD COLUMN company_phone text, ADD COLUMN company_whatsapp text, ADD COLUMN company_email text,
  ADD COLUMN logo_data text;

ALTER TABLE contract_templates ADD COLUMN type text NOT NULL DEFAULT 'locacao_residencial'
  CHECK (type IN ('locacao_residencial','locacao_comercial','temporada','garagem','aditivo','distrato','entrega_chaves','outro'));

-- format 1 = texto simples (documentos antigos, que não mudam); 2 = com identidade visual.
-- layout guarda a identidade e as partes DO MOMENTO da emissão (o documento continua imutável).
ALTER TABLE contract_documents ADD COLUMN doc_type text, ADD COLUMN number text, ADD COLUMN format smallint NOT NULL DEFAULT 1, ADD COLUMN layout jsonb;
CREATE UNIQUE INDEX contract_documents_number ON contract_documents (organization_id, number);

CREATE TABLE document_counters (
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  year integer NOT NULL,
  last_number integer NOT NULL,
  PRIMARY KEY (organization_id, year)
);
ALTER TABLE document_counters ENABLE ROW LEVEL SECURITY;
