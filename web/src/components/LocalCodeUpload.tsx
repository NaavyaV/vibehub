import { useRef, useState } from "react";
import { readLocalFolder } from "../lib/local-files";
import { Alert, Stack } from "./ui";
import { PrivateRepoConnect } from "./PrivateRepoConnect";

export function LocalCodeUpload({
  repoName,
  onRepoNameChange,
  isPrivate,
  onPrivateChange,
  onFilesReady,
  disabled = false,
  hasPrivateRepoAccess = false,
}: {
  repoName: string;
  onRepoNameChange: (name: string) => void;
  isPrivate: boolean;
  onPrivateChange: (value: boolean) => void;
  onFilesReady: (files: Array<{ path: string; content: string }>, summary: string) => void;
  disabled?: boolean;
  hasPrivateRepoAccess?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFolder(event: React.ChangeEvent<HTMLInputElement>) {
    const list = event.target.files;
    if (!list || list.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const result = await readLocalFolder(list);
      if (result.files.length === 0) {
        setError(
          result.scanned > 0
            ? `No uploadable files after filtering (${result.skipped.toLocaleString()} skipped).`
            : "No text files found in that folder.",
        );
        setSummary(null);
        onFilesReady([], "");
        return;
      }
      const label = `${result.files.length} files · ${result.skipped.toLocaleString()} skipped`;
      setSummary(label);
      onFilesReady(result.files, label);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read that folder.");
      setSummary(null);
      onFilesReady([], "");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Stack gap="sm">
      <label className="field">
        Project name
        <input
          value={repoName}
          onChange={(event) => onRepoNameChange(event.target.value)}
          placeholder="my-vibehub-project"
          disabled={disabled || busy}
          autoComplete="off"
        />
      </label>
      <label className="checkbox-field">
        <input
          type="checkbox"
          checked={isPrivate}
          onChange={(event) => onPrivateChange(event.target.checked)}
          disabled={disabled || busy}
        />
        Private repository
      </label>
      {isPrivate && !hasPrivateRepoAccess ? <PrivateRepoConnect /> : null}

      <button
        type="button"
        className="btn btn-secondary"
        disabled={disabled || busy}
        onClick={() => inputRef.current?.click()}
      >
        {busy ? "Reading folder…" : "Choose project folder"}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="*/*"
        multiple
        hidden
        {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
        onChange={(event) => void handleFolder(event)}
      />

      <p className="muted">
        Skips <code>node_modules</code>, <code>dist</code>, <code>.git</code>, and secrets automatically.
      </p>
      {summary ? <Alert variant="success">{summary}</Alert> : null}
      {error ? <Alert variant="error">{error}</Alert> : null}
    </Stack>
  );
}
