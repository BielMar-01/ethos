-- Moradores e acessos 2: visitas recorrentes, avisos de atraso, foto do visitante, encomendas.

ALTER TABLE visitors ADD COLUMN weekdays text;                  -- "1,3,5" (0=domingo … 6=sábado); vazio = todos os dias
ALTER TABLE visitors ADD COLUMN time_from time;                 -- janela de horário permitida (Brasília)
ALTER TABLE visitors ADD COLUMN time_to time;
ALTER TABLE visitors ADD COLUMN expected_time time;             -- hora prevista da chegada (aviso se não vier)
ALTER TABLE visitors ADD COLUMN max_stay_minutes integer CHECK (max_stay_minutes IS NULL OR max_stay_minutes BETWEEN 10 AND 1440);
ALTER TABLE visitors ADD COLUMN not_arrived_alert_date date;    -- dia em que já avisamos que não chegou
ALTER TABLE visitors ADD COLUMN photo_consent_at timestamptz;
ALTER TABLE visitors ADD CONSTRAINT visitors_time_window CHECK ((time_from IS NULL) = (time_to IS NULL));
ALTER TABLE access_events ADD COLUMN overstay_alerted_at timestamptz;

-- Foto do visitante (LGPD: só com consentimento registrado; apagada depois do fim da autorização).
CREATE TABLE visitor_photos (
  visitor_id integer PRIMARY KEY REFERENCES visitors(id) ON DELETE CASCADE,
  content_type text NOT NULL,
  data bytea NOT NULL,
  taken_by integer REFERENCES users(id) ON DELETE SET NULL,
  taken_at timestamptz NOT NULL DEFAULT now()
);

-- Encomendas recebidas na portaria.
CREATE TABLE parcels (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  unit_id integer NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  lease_id integer REFERENCES leases(id) ON DELETE SET NULL,
  description text NOT NULL,
  carrier text,
  recipient_name text,
  status text NOT NULL DEFAULT 'recebida' CHECK (status IN ('recebida','retirada','devolvida')),
  received_at timestamptz NOT NULL DEFAULT now(),
  received_by integer REFERENCES users(id) ON DELETE SET NULL,
  picked_up_at timestamptz,
  picked_up_by_name text,
  handled_by integer REFERENCES users(id) ON DELETE SET NULL,
  reminder_sent_at timestamptz,
  notes text
);
CREATE INDEX parcels_open ON parcels (organization_id, status, received_at);
CREATE INDEX parcels_unit ON parcels (unit_id);
ALTER TABLE visitor_photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE parcels ENABLE ROW LEVEL SECURITY;
