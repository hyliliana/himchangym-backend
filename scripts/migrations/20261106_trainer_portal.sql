-- Existing reservations retain automatic approval; repeated runs do not rewrite approvals.
-- Replace only kind-related account checks, retaining email/name/role validation.
DO $$
DECLARE constraint_row record;
BEGIN
 FOR constraint_row IN
  SELECT conname FROM pg_constraint
  WHERE conrelid='hw2.accounts'::regclass AND contype='c'
   AND pg_get_constraintdef(oid) ~ '\mkind\M'
 LOOP
  EXECUTE format('ALTER TABLE hw2.accounts DROP CONSTRAINT %I',constraint_row.conname);
 END LOOP;
 ALTER TABLE hw2.accounts ADD CONSTRAINT accounts_kind_check CHECK (kind IN ('member','staff','trainer'));
 ALTER TABLE hw2.accounts ADD CONSTRAINT accounts_kind_role_check CHECK (
  (kind IN ('member','trainer') AND role IS NULL) OR (kind='staff' AND role IS NOT NULL)
 );
END $$;
ALTER TABLE hw2.trainers ADD COLUMN IF NOT EXISTS account_id integer UNIQUE REFERENCES hw2.accounts(id);
ALTER TABLE hw2.reservations ADD COLUMN IF NOT EXISTS approval text NOT NULL DEFAULT 'approved';
DO $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='hw2.reservations'::regclass AND conname='reservation_approval_check') THEN
  ALTER TABLE hw2.reservations ADD CONSTRAINT reservation_approval_check CHECK (approval IN ('pending','approved','rejected'));
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='hw2.reservations'::regclass AND conname='reservation_approval_status_check') THEN
  ALTER TABLE hw2.reservations ADD CONSTRAINT reservation_approval_status_check CHECK (
   (approval<>'rejected' OR status='cancelled') AND (status NOT IN ('completed','noshow') OR approval='approved')
  );
 END IF;
END $$;
