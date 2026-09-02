CREATE TABLE project_invites (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  invitee_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invited_by      TEXT NOT NULL REFERENCES users(id),
  role            TEXT NOT NULL DEFAULT 'member',
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'accepted', 'declined')),
  created_at      TEXT NOT NULL,
  responded_at    TEXT
);

CREATE INDEX idx_invites_invitee ON project_invites(invitee_user_id, status);
CREATE INDEX idx_invites_project ON project_invites(project_id, status);
