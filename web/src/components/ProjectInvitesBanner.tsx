import { Card } from "./ui";

export type PendingInvite = {
  id: string;
  project_id: string;
  project_name: string;
  role: string;
  inviter_name: string;
  inviter_github: string | null;
  created_at: string;
};

export function ProjectInvitesBanner({
  invites,
  busy,
  onAccept,
  onDecline,
}: {
  invites: PendingInvite[];
  busy?: boolean;
  onAccept: (inviteId: string) => void;
  onDecline: (inviteId: string) => void;
}) {
  if (invites.length === 0) return null;

  return (
    <Card className="invites-banner">
      <h2 className="section-title">Project invites</h2>
      <ul className="invites-list">
        {invites.map((invite) => (
          <li key={invite.id} className="invite-row">
            <div className="invite-info">
              <strong>{invite.project_name}</strong>
              <p className="muted invite-meta">
                {invite.inviter_name}
                {invite.inviter_github ? ` (@${invite.inviter_github})` : ""} invited you as{" "}
                {invite.role}
              </p>
            </div>
            <div className="invite-actions">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={busy}
                onClick={() => onAccept(invite.id)}
              >
                Accept
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={busy}
                onClick={() => onDecline(invite.id)}
              >
                Decline
              </button>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
