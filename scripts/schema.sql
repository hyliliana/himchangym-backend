CREATE SCHEMA IF NOT EXISTS hw2;
CREATE TABLE IF NOT EXISTS hw2.accounts (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 email text NOT NULL UNIQUE CHECK (email = lower(email)), password_hash text NOT NULL,
 name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
 kind text NOT NULL CHECK (kind IN ('member','staff')),
 role text CHECK (role IN ('admin','employee')), is_active boolean NOT NULL DEFAULT true,
 must_change_password boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((kind='member' AND role IS NULL) OR (kind='staff' AND role IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS hw2.members (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 account_id integer NOT NULL UNIQUE REFERENCES hw2.accounts(id),
 name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
 phone text NOT NULL UNIQUE CHECK (phone ~ '^0[0-9]{8,10}$'), joined_at date NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Seoul')::date
);
CREATE TABLE IF NOT EXISTS hw2.trainers (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
 working_days integer[] NOT NULL CHECK (working_days <@ ARRAY[0,1,2,3,4,5,6])
);
CREATE TABLE IF NOT EXISTS hw2.pass_types (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
 total_sessions integer NOT NULL CHECK (total_sessions IN (10,20,30)),
 list_price integer NOT NULL CHECK (list_price >= 0), valid_days integer NOT NULL CHECK (valid_days BETWEEN 1 AND 3650)
);
CREATE TABLE IF NOT EXISTS hw2.passes (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 member_id integer NOT NULL REFERENCES hw2.members(id), type_id integer NOT NULL REFERENCES hw2.pass_types(id),
 purchased_on date NOT NULL, paid_amount integer NOT NULL CHECK (paid_amount >= 0),
 expires_on date NOT NULL, total_sessions integer NOT NULL CHECK (total_sessions IN (10,20,30)),
 CHECK (expires_on >= purchased_on), UNIQUE(id,member_id)
);
CREATE TABLE IF NOT EXISTS hw2.reservations (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 member_id integer NOT NULL REFERENCES hw2.members(id),
 pass_id integer NOT NULL, trainer_id integer NOT NULL REFERENCES hw2.trainers(id),
 starts_at timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'booked' CHECK (status IN ('booked','completed','cancelled','noshow')),
 note text NOT NULL DEFAULT '' CHECK (length(note) <= 5000),
 FOREIGN KEY(pass_id,member_id) REFERENCES hw2.passes(id,member_id),
 CHECK (EXTRACT(MINUTE FROM starts_at AT TIME ZONE 'Asia/Seoul')=0 AND EXTRACT(SECOND FROM starts_at AT TIME ZONE 'Asia/Seoul')=0)
);
CREATE UNIQUE INDEX IF NOT EXISTS reservation_trainer_time ON hw2.reservations(trainer_id,starts_at) WHERE status <> 'cancelled';
CREATE UNIQUE INDEX IF NOT EXISTS reservation_member_time ON hw2.reservations(member_id,starts_at) WHERE status <> 'cancelled';
CREATE INDEX IF NOT EXISTS reservation_pass ON hw2.reservations(pass_id);
CREATE INDEX IF NOT EXISTS passes_expiration ON hw2.passes(expires_on);
CREATE TABLE IF NOT EXISTS hw2.sessions (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 account_id integer NOT NULL REFERENCES hw2.accounts(id), token_hash text NOT NULL UNIQUE,
 expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hw2.pass_receipts (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 pass_id integer NOT NULL REFERENCES hw2.passes(id),
 uploader_id integer NOT NULL REFERENCES hw2.accounts(id),
 file_name text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 120),
 mime_type text NOT NULL CHECK (mime_type IN ('image/jpeg','image/png','image/webp')),
 image_data bytea NOT NULL CHECK (octet_length(image_data) BETWEEN 1 AND 2097152),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pass_receipts_pass ON hw2.pass_receipts(pass_id);
