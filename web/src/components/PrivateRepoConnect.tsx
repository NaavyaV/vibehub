import { githubPrivateRepoAuthUrl } from "../lib/api";
import { Alert } from "./ui";

export function PrivateRepoConnect({ className }: { className?: string }) {
  return (
    <div className={className}>
      <Alert variant="warn">
        Private repos need an extra GitHub permission. On GitHub&apos;s screen, deny any organization
        you don&apos;t want VibeHub to access.
      </Alert>
      <a className="btn btn-primary" href={githubPrivateRepoAuthUrl()} style={{ marginTop: 12 }}>
        Reconnect for private repos
      </a>
    </div>
  );
}

export function needsPrivateRepoReconnect(details: unknown, message?: string): boolean {
  if (
    details &&
    typeof details === "object" &&
    "code" in details &&
    (details as { code?: string }).code === "private_repo_access_required"
  ) {
    return true;
  }
  const text = (message ?? "").toLowerCase();
  return text.includes("private-repo") || text.includes("private repos");
}
