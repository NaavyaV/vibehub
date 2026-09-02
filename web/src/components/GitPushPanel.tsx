import { useState } from "react";
import { api } from "../lib/api";
import { Alert, CopyBlock, Stack } from "./ui";
import { PrivateRepoConnect } from "./PrivateRepoConnect";

type PrepareResult = {
  repo_url: string;
  git_commands: string[];
  notes: string[];
};

export function GitPushPanel({
  repoName,
  onRepoNameChange,
  isPrivate,
  onPrivateChange,
  hasPrivateRepoAccess,
  disabled = false,
  onPrepared,
  onImport,
  busy = false,
}: {
  repoName: string;
  onRepoNameChange: (name: string) => void;
  isPrivate: boolean;
  onPrivateChange: (value: boolean) => void;
  hasPrivateRepoAccess?: boolean;
  disabled?: boolean;
  onPrepared: (repoUrl: string) => void;
  onImport: () => void;
  busy?: boolean;
}) {
  const [prep, setPrep] = useState<PrepareResult | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function prepare() {
    setPreparing(true);
    setError(null);
    try {
      const result = await api<PrepareResult>("/api/projects/prepare-git-push", {
        method: "POST",
        body: JSON.stringify({
          repo_name: repoName,
          private: isPrivate,
          folder_hint: ".",
        }),
      });
      setPrep(result);
      onPrepared(result.repo_url);
    } catch (err) {
      setPrep(null);
      setError(err instanceof Error ? err.message : "Could not create repository.");
    } finally {
      setPreparing(false);
    }
  }

  return (
    <Stack gap="sm">
      <label className="field">
        Repository name
        <input
          value={repoName}
          onChange={(event) => onRepoNameChange(event.target.value)}
          placeholder="my-app"
          disabled={disabled || preparing || busy}
        />
      </label>

      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={isPrivate}
          onChange={(event) => onPrivateChange(event.target.checked)}
          disabled={disabled || preparing || busy || !hasPrivateRepoAccess}
        />
        Private repository
      </label>
      {isPrivate && !hasPrivateRepoAccess ? <PrivateRepoConnect /> : null}

      {!prep ? (
        <button
          type="button"
          className="btn btn-primary"
          disabled={
            disabled ||
            preparing ||
            busy ||
            !repoName.trim() ||
            (isPrivate && !hasPrivateRepoAccess)
          }
          onClick={() => void prepare()}
        >
          {preparing ? "Creating repo…" : "Create empty GitHub repo"}
        </button>
      ) : (
        <>
          <Alert variant="success">
            Repo ready: <strong>{prep.repo_url.replace(/^https:\/\/github\.com\//, "")}</strong>
          </Alert>
          <p className="muted">Run from your project folder:</p>
          <CopyBlock text={prep.git_commands.join("\n")} label="Copy commands" />
          <ul className="auth-bullets">
            {prep.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
          <div className="row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={disabled || busy}
              onClick={onImport}
            >
              {busy ? "Importing…" : "I've pushed — import project"}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={preparing || busy}
              onClick={() => {
                setPrep(null);
                setError(null);
              }}
            >
              Start over
            </button>
          </div>
        </>
      )}

      {error ? <Alert variant="error">{error}</Alert> : null}
    </Stack>
  );
}
