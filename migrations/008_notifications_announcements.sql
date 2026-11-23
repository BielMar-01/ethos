-- Notificações internas, preferências e comunicados (docs/CONTEXTO-ETHOS.md §8.9).
-- Canal implementado: "internas" (dentro do sistema). E-mail/WhatsApp/push ficam para depois e
-- exigem consentimento; por isso a preferência já é por categoria e por usuário.

CREATE TABLE notifications (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category text NOT NULL CHECK (category IN ('financeiro','manutencao','vistoria','contrato','comunicado')),
  kind text NOT NULL,
  title text NOT NULL,
  body text,
  link_kind text,                      -- para onde levar o usuário (maintenance, inspection, charge, announcement, lease…)
  link_id integer,
  dedupe_key text,                     -- evita repetir o mesmo lembrete para a mesma pessoa
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX notifications_dedupe
  ON notifications (organization_id, user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX notifications_inbox ON notifications (user_id, organization_id, created_at DESC);
CREATE INDEX notifications_unread ON notifications (user_id, organization_id) WHERE read_at IS NULL;

-- Sem linha = ativado. Só guarda a escolha explícita do usuário.
CREATE TABLE notification_preferences (
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  category text NOT NULL CHECK (category IN ('financeiro','manutencao','vistoria','contrato','comunicado')),
  in_app boolean NOT NULL DEFAULT true,
  PRIMARY KEY (user_id, organization_id, category)
);

CREATE TABLE announcements (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title text NOT NULL,
  body text NOT NULL,
  audience text NOT NULL CHECK (audience IN ('todos','inquilinos','proprietarios','imovel')),
  property_id integer REFERENCES properties(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'rascunho' CHECK (status IN ('rascunho','publicado','arquivado')),
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((audience = 'imovel') = (property_id IS NOT NULL)),
  CHECK ((status = 'rascunho') = (published_at IS NULL))
);

CREATE INDEX ON announcements (organization_id, status, published_at DESC);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE announcements ENABLE ROW LEVEL SECURITY;
