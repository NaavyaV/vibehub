import { Link } from "react-router-dom";

export function CompactSetupBar({
  hasRepoAccess,
  hasMcpToken,
  repoAuthUrl,
}: {
  hasRepoAccess: boolean;
  hasMcpToken: boolean;
  repoAuthUrl?: string;
}) {
  const ready = hasRepoAccess && hasMcpToken;

  return (
    <div className="setup-bar" role="list" aria-label="Setup progress">
      <SetupChip
        done={hasRepoAccess}
        label="GitHub"
        href={hasRepoAccess ? undefined : repoAuthUrl}
      />
      <SetupChip done={hasMcpToken} label="MCP token" href={hasMcpToken ? undefined : "/settings"} />
      <SetupChip done={ready} label="Ready to push" />
    </div>
  );
}

function SetupChip({
  done,
  label,
  href,
}: {
  done: boolean;
  label: string;
  href?: string;
}) {
  const content = (
    <>
      <span className="setup-bar-check" aria-hidden>
        {done ? "✓" : "○"}
      </span>
      <span>{label}</span>
    </>
  );

  return (
    <span
      className={`setup-bar-item${done ? " setup-bar-item--done" : ""}`}
      role="listitem"
    >
      {href && !done ? (
        href.startsWith("/") ? (
          <Link to={href} className="setup-bar-link">
            {content}
          </Link>
        ) : (
          <a href={href} className="setup-bar-link">
            {content}
          </a>
        )
      ) : (
        content
      )}
    </span>
  );
}
