CREATE TABLE IF NOT EXISTS hw2.lesson_time_requests (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reservation_id integer NOT NULL REFERENCES hw2.reservations(id) ON DELETE CASCADE,
  original_start timestamptz NOT NULL,
  proposed_start timestamptz NOT NULL CHECK (proposed_start <> original_start),
  requested_by integer NOT NULL REFERENCES hw2.accounts(id),
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','approved','rejected','withdrawn')),
  resolved_by integer REFERENCES hw2.accounts(id),
  resolved_at timestamptz,
  CHECK ((state='pending') = (resolved_at IS NULL)),
  CHECK ((state='pending') = (resolved_by IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS lesson_one_pending_request
  ON hw2.lesson_time_requests(reservation_id) WHERE state='pending';
CREATE TABLE IF NOT EXISTS hw2.lesson_history (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reservation_id integer NOT NULL REFERENCES hw2.reservations(id) ON DELETE CASCADE,
  actor_id integer NOT NULL REFERENCES hw2.accounts(id),
  actor_name text NOT NULL,
  actor_role text NOT NULL CHECK (actor_role IN ('member','trainer','admin','employee')),
  event text NOT NULL CHECK (event IN ('requested','approved_change','rejected_change','withdrawn','booked','approval','status','feedback')),
  previous_values jsonb NOT NULL,
  new_values jsonb NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS lesson_history_order ON hw2.lesson_history(reservation_id,id);
