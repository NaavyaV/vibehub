import type { Feature } from "./TaskGraph";

export type ActivityPush = {
  push_id: string;
  feature_id: string;
  status: string;
  merged_version: number | null;
  changed_paths: string[];
  error: string | null;
  created_at: string;
  created_by_name: string | null;
  created_by_github: string | null;
  created_by_avatar: string | null;
};

function featureTitle(features: Feature[], slug: string): string {
  return features.find((f) => f.id === slug)?.title ?? slug.replace(/-/g, " ");
}

function actorLabel(push: ActivityPush): string {
  if (push.created_by_name) return push.created_by_name;
  if (push.created_by_github) return `@${push.created_by_github}`;
  return "Someone";
}

function changeDescription(push: ActivityPush, features: Feature[]): string {
  const task = featureTitle(features, push.feature_id);
  const who = actorLabel(push);

  if (push.status === "merged" || push.status === "success") {
    const version =
      push.merged_version != null ? ` (now v${push.merged_version})` : "";
    return `${who} shipped “${task}”${version}`;
  }
  if (push.status === "pending" || push.status === "running" || push.status === "testing") {
    return `${who} is testing “${task}”`;
  }
  if (push.status === "conflict") {
    return `${who} hit a merge conflict on “${task}”`;
  }
  if (push.status === "failed") {
    return `${who}'s update failed on “${task}”`;
  }
  const fileCount = push.changed_paths.length;
  const files =
    fileCount > 0
      ? ` (${fileCount} file${fileCount === 1 ? "" : "s"})`
      : "";
  return `${who} updated “${task}”${files}`;
}

function formatWhen(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function isTerminalFailure(status: string): boolean {
  return status === "failed" || status === "conflict";
}

function isShipped(status: string): boolean {
  return status === "merged" || status === "success";
}

/**
 * Drop failed/conflict attempts for a feature once a later ship for that feature
 * exists — the story is “it shipped,” not the retries that got there.
 */
export function visibleShippedEvents(pushes: ActivityPush[]): ActivityPush[] {
  const shippedFeatures = new Set(
    pushes.filter((p) => isShipped(p.status)).map((p) => p.feature_id),
  );

  return [...pushes]
    .filter((push) => {
      if (isTerminalFailure(push.status) && shippedFeatures.has(push.feature_id)) {
        return false;
      }
      return true;
    })
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}

export function WhatsShippedFeed({
  pushes,
  features,
  currentVersion,
}: {
  pushes: ActivityPush[];
  features: Feature[];
  currentVersion: number;
}) {
  const events = visibleShippedEvents(pushes).slice(0, 20);

  return (
    <section className="shipped-feed" aria-label="What's shipped">
      <header className="shipped-feed-header">
        <div>
          <h2 className="shipped-feed-title">What&apos;s shipped</h2>
          <p className="shipped-feed-desc">
            Recent updates from the team — each verified push becomes a new version on main.
          </p>
        </div>
        <div className="shipped-feed-version">
          <span className="shipped-feed-version-label">Live</span>
          <span className="shipped-feed-version-num">v{currentVersion}</span>
        </div>
      </header>

      {events.length === 0 ? (
        <p className="muted shipped-feed-empty">
          No updates yet. When someone finishes a task and pushes to VibeHub, it shows up here.
        </p>
      ) : (
        <ol className="shipped-chain shipped-chain-scroll">
          {events.map((push, index) => (
            <li key={push.push_id} className={`shipped-chain-item shipped-${push.status}`}>
              <div className="shipped-chain-node">
                {push.created_by_avatar ? (
                  <img
                    src={push.created_by_avatar}
                    alt=""
                    className="shipped-chain-avatar"
                  />
                ) : (
                  <span className="shipped-chain-avatar shipped-chain-avatar-fallback" aria-hidden>
                    {actorLabel(push).charAt(0).toUpperCase()}
                  </span>
                )}
                <div className="shipped-chain-body">
                  <p className="shipped-chain-change">{changeDescription(push, features)}</p>
                  <p className="shipped-chain-when">{formatWhen(push.created_at)}</p>
                  {push.error && !isShipped(push.status) ? (
                    <p className="form-error">{push.error}</p>
                  ) : null}
                </div>
              </div>
              {index < events.length - 1 ? (
                <div className="shipped-chain-arrow" aria-hidden>
                  <span className="shipped-chain-arrow-head">↑</span>
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
