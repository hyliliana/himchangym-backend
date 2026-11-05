-- Non-destructive and repeatable. Existing identities, purchases and histories remain.
ALTER TABLE IF EXISTS hw2.members ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE IF EXISTS hw2.trainers ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE IF EXISTS hw2.pass_types ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
