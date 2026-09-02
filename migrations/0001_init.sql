-- VibeHub initial schema.
--
-- D1 holds metadata ONLY. File contents live in the project's GitHub repo and
-- are never written to any column here.

CREATE TABLE users (
  id                TEXT PRIMARY KEY,
  github_login      TEXT UNIQUE,
  display_name      TEXT NOT NULL,
  avatar_url        TEXT,
  -- AES-GCM encrypted GitHub OAuth access token, used to reach the user's repos.
  github_token_enc  TEXT,
  created_at        TEXT NOT NULL
);

CREATE TABLE projects (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  repo_url              TEXT,
  storage_provider      TEXT NOT NULL DEFAULT 'github',
  current_version       INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL,
  -- Parsed from repo_url so the GitHub client does not re-parse on every call.
  repo_owner            TEXT,
  repo_name             TEXT,
  default_branch        TEXT NOT NULL DEFAULT 'main',
  -- AES-GCM encrypted token used for commits/dispatch on this repo.
  github_token_enc      TEXT,
  -- 'actions' = real GitHub Actions build gate, 'skip' = auto-pass the gate.
  test_mode             TEXT NOT NULL DEFAULT 'actions',
  -- shared_file_warnings from the imported plan, surfaced in the UI as a heads-up.
  shared_file_warnings  TEXT NOT NULL DEFAULT '[]',
  created_by            TEXT REFERENCES users(id)
);

CREATE TABLE project_members (
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'member',
  created_at  TEXT NOT NULL,
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE features (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- The lowercase-hyphenated id from the imported plan. Unique per project, and
  -- what humans and agents actually refer to.
  slug          TEXT NOT NULL,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'available'
                  CHECK (status IN ('available','claimed','in_progress','merged','blocked')),
  assigned_to   TEXT REFERENCES users(id),
  scope_notes   TEXT NOT NULL DEFAULT '',
  manifest      TEXT NOT NULL DEFAULT '{"routes":[],"exports":[],"deps":[]}',
  test_spec     TEXT,
  position      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (project_id, slug)
);

CREATE TABLE feature_dependencies (
  feature_id            TEXT NOT NULL REFERENCES features(id) ON DELETE CASCADE,
  depends_on_feature_id TEXT NOT NULL REFERENCES features(id) ON DELETE CASCADE,
  PRIMARY KEY (feature_id, depends_on_feature_id)
);

CREATE TABLE versions (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version_number        INTEGER NOT NULL,
  commit_sha            TEXT,
  created_by_feature_id TEXT REFERENCES features(id),
  -- JSON array of repo-relative paths written by this version. The basis of all
  -- conflict detection.
  changed_paths         TEXT NOT NULL DEFAULT '[]',
  created_at            TEXT NOT NULL,
  UNIQUE (project_id, version_number)
);

CREATE TABLE pushes (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  feature_id          TEXT NOT NULL REFERENCES features(id) ON DELETE CASCADE,
  based_on_version    INTEGER NOT NULL,
  status              TEXT NOT NULL
                        CHECK (status IN ('testing','conflict','merged','failed')),
  -- Internal progress within `status = 'testing'`, so the spec's status enum
  -- stays exactly as specified.
  stage               TEXT NOT NULL DEFAULT 'queued'
                        CHECK (stage IN ('queued','applying','building','done')),
  changed_paths       TEXT NOT NULL DEFAULT '[]',
  conflict_paths      TEXT NOT NULL DEFAULT '[]',
  conflict_reason     TEXT,
  staging_ref         TEXT,
  commit_sha          TEXT,
  merged_version      INTEGER,
  build_output        TEXT,
  error               TEXT,
  notes               TEXT,
  -- sha256 of the one-time token the GitHub Actions run must present.
  callback_token_hash TEXT,
  webhook_url         TEXT,
  created_by          TEXT REFERENCES users(id),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE TABLE snapshots (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  feature_id  TEXT REFERENCES features(id) ON DELETE SET NULL,
  description TEXT NOT NULL DEFAULT '',
  -- A git ref/sha in the connected repo. Never file content.
  storage_ref TEXT NOT NULL,
  created_by  TEXT REFERENCES users(id),
  created_at  TEXT NOT NULL
);

CREATE TABLE blockers (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  feature_id  TEXT NOT NULL REFERENCES features(id) ON DELETE CASCADE,
  reason      TEXT NOT NULL,
  reported_by TEXT REFERENCES users(id),
  created_at  TEXT NOT NULL,
  resolved_at TEXT
);

-- Personal access tokens for MCP clients that cannot complete an OAuth flow.
CREATE TABLE api_tokens (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL DEFAULT '',
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT
);

CREATE INDEX idx_features_project ON features(project_id, status);
CREATE INDEX idx_features_assignee ON features(project_id, assigned_to);
CREATE INDEX idx_feature_deps_dependent ON feature_dependencies(depends_on_feature_id);
CREATE INDEX idx_versions_project ON versions(project_id, version_number);
CREATE INDEX idx_pushes_project ON pushes(project_id, created_at);
CREATE INDEX idx_pushes_feature ON pushes(feature_id, created_at);
CREATE INDEX idx_snapshots_project ON snapshots(project_id, created_at);
CREATE INDEX idx_blockers_project ON blockers(project_id, resolved_at);
CREATE INDEX idx_members_user ON project_members(user_id);
