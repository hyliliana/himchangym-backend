-- Repeatable scheduling extension: original reservations and contracts are never rewritten.
CREATE TABLE IF NOT EXISTS hw2.facility_settings (
 id integer PRIMARY KEY CHECK (id=1), start_hour integer NOT NULL CHECK (start_hour BETWEEN 0 AND 23),
 end_hour integer NOT NULL CHECK (end_hour BETWEEN 1 AND 24), capacity integer NOT NULL CHECK (capacity BETWEEN 1 AND 100),
 CHECK (start_hour<end_hour)
);
INSERT INTO hw2.facility_settings(id,start_hour,end_hour,capacity) VALUES(1,9,22,2) ON CONFLICT(id) DO NOTHING;
CREATE TABLE IF NOT EXISTS hw2.trainer_contracts (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, trainer_id integer NOT NULL REFERENCES hw2.trainers(id),
 start_date date NOT NULL, end_date date NOT NULL, min_slots integer NOT NULL CHECK(min_slots BETWEEN 0 AND 10000),
 max_slots integer NOT NULL CHECK(max_slots BETWEEN 1 AND 10000),
 allowed_weekdays integer[] NOT NULL CHECK(allowed_weekdays <@ ARRAY[0,1,2,3,4,5,6] AND cardinality(allowed_weekdays) BETWEEN 1 AND 7),
 start_hour integer NOT NULL CHECK(start_hour BETWEEN 0 AND 23), end_hour integer NOT NULL CHECK(end_hour BETWEEN 1 AND 24),
 is_current boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(start_date<=end_date), CHECK(min_slots<=max_slots), CHECK(start_hour<end_hour)
);
CREATE UNIQUE INDEX IF NOT EXISTS trainer_current_contract ON hw2.trainer_contracts(trainer_id) WHERE is_current;
CREATE TABLE IF NOT EXISTS hw2.trainer_slots (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, trainer_id integer NOT NULL REFERENCES hw2.trainers(id),
 contract_id integer NOT NULL REFERENCES hw2.trainer_contracts(id), starts_at timestamptz NOT NULL,
 status text NOT NULL CHECK(status IN ('approved','pending','rejected','withdrawn')), within_scope boolean NOT NULL,
 reason text NOT NULL DEFAULT '' CHECK(length(reason)<=1000), created_by integer NOT NULL REFERENCES hw2.accounts(id),
 decided_by integer REFERENCES hw2.accounts(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(EXTRACT(MINUTE FROM starts_at AT TIME ZONE 'Asia/Seoul')=0 AND EXTRACT(SECOND FROM starts_at AT TIME ZONE 'Asia/Seoul')=0)
);
CREATE UNIQUE INDEX IF NOT EXISTS trainer_slot_time ON hw2.trainer_slots(trainer_id,starts_at) WHERE status IN ('approved','pending');
CREATE INDEX IF NOT EXISTS trainer_slot_contract ON hw2.trainer_slots(contract_id);
CREATE INDEX IF NOT EXISTS trainer_slot_facility_time ON hw2.trainer_slots(starts_at) WHERE status IN ('approved','pending');
