-- No backfill/opt-in: absent rows mean false/false with no recorded choice time.
CREATE TABLE IF NOT EXISTS hw2.member_notification_preferences (
 member_id integer PRIMARY KEY REFERENCES hw2.members(id),
 kakao boolean NOT NULL DEFAULT false,
 sms boolean NOT NULL DEFAULT false,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS hw2.notification_preference_audit (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 member_id integer NOT NULL REFERENCES hw2.members(id),
 actor_account_id integer NOT NULL REFERENCES hw2.accounts(id),
 before_kakao boolean NOT NULL, before_sms boolean NOT NULL,
 after_kakao boolean NOT NULL, after_sms boolean NOT NULL,
 changed_at timestamptz NOT NULL,
 CHECK (before_kakao IS DISTINCT FROM after_kakao OR before_sms IS DISTINCT FROM after_sms)
);
