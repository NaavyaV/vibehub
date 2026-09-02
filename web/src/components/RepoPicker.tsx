import { useEffect, useMemo, useState } from "react";
import { api, githubPrivateRepoAuthUrl, githubRepoAuthUrl } from "../lib/api";
import { Alert } from "./ui";
import { PrivateRepoConnect } from "./PrivateRepoConnect";

export type GithubRepoOption = {
  full_name: string;
  name: string;
  owner: string;
  html_url: string;
  private: boolean;
  description: string | null;
  updated_at: string | null;
  default_branch: string;
};

export function RepoPicker({
  value,
  onChange,
  enabled = true,
  hasPrivateRepoAccess = false,
}: {
  value: string;
  onChange: (htmlUrl: string, repo: GithubRepoOption | null) => void;
  enabled?: boolean;
  hasPrivateRepoAccess?: boolean;
}) {
  const [repos, setRepos] = useState<GithubRepoOption[] | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await api<{ repos: GithubRepoOption[] }>("/api/github/repos");
        if (!cancelled) setRepos(data.repos);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Could not load repos.");
          setRepos([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const filtered = useMemo(() => {
    if (!repos) return [];
    const q = query.trim().toLowerCase();
    if (!q) return repos;
    return repos.filter(
      (repo) =>
        repo.full_name.toLowerCase().includes(q) ||
        (repo.description ?? "").toLowerCase().includes(q),
    );
  }, [repos, query]);

  if (!enabled) {
    return (
      <div className="repo-picker">
        <Alert variant="warn">
          Connect GitHub to pick a repo. Personal repos only — no organization access.
        </Alert>
        <a className="btn btn-primary" href={githubRepoAuthUrl()}>
          Connect GitHub
        </a>
      </div>
    );
  }

  if (loading && !repos) {
    return <p className="loading-line">Loading repositories…</p>;
  }

  if (error) {
    return <Alert variant="error">{error}</Alert>;
  }

  if (repos && repos.length === 0) {
    return (
      <div className="repo-picker">
        <Alert variant="warn">No personal repositories found on your GitHub account.</Alert>
        {!hasPrivateRepoAccess ? <PrivateRepoConnect /> : null}
      </div>
    );
  }

  return (
    <div className="repo-picker">
      {!hasPrivateRepoAccess ? (
        <p className="muted">
          Missing a private repo?{" "}
          <a href={githubPrivateRepoAuthUrl()}>Reconnect for private access</a>
        </p>
      ) : null}
      <label className="field">
        Search
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter by name…"
          autoComplete="off"
        />
      </label>
      <div className="repo-list" role="listbox" aria-label="Your GitHub repositories">
        {filtered.map((repo) => {
          const selected = value === repo.html_url || value === repo.full_name;
          return (
            <button
              key={repo.full_name}
              type="button"
              role="option"
              aria-selected={selected}
              className={`repo-option${selected ? " selected" : ""}`}
              onClick={() => onChange(repo.html_url, repo)}
            >
              <span className="repo-option-main">
                <strong>{repo.full_name}</strong>
                {repo.private ? <span className="repo-badge">Private</span> : null}
              </span>
              {repo.description ? <span className="repo-option-desc">{repo.description}</span> : null}
            </button>
          );
        })}
        {filtered.length === 0 ? (
          <p className="muted" style={{ padding: "1rem" }}>
            No repos match &ldquo;{query}&rdquo;.
          </p>
        ) : null}
      </div>
    </div>
  );
}
