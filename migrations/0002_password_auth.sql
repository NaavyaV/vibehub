-- Optional columns retained for schema stability. Auth is GitHub OAuth only;
-- email / password_hash are unused by the application.

ALTER TABLE users ADD COLUMN email TEXT;
ALTER TABLE users ADD COLUMN password_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL;
