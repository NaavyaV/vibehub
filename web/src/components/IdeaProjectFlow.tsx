import { useEffect, useState } from "react";
import { ApiError, api, githubRepoAuthUrl } from "../lib/api";
import { Alert, Stack } from "./ui";

export function IdeaProjectFlow({
  onCreated,
  onCancel,
  hasRepoAccess,
  hasPrivateRepoAccess,
}: {
  onCreated: (projectId: string) => void;
  onCancel: () => void;
  hasRepoAccess: boolean;
  hasPrivateRepoAccess: boolean;
}) {
  const [step, setStep] = useState<1 | 2>(1);
  const [idea, setIdea] = useState("");
  const [prompt, setPrompt] = useState("");
  const [planText, setPlanText] = useState("");
  const [privateRepo, setPrivateRepo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadingPrompt, setLoadingPrompt] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function goToPromptStep() {
    const trimmed = idea.trim();
    if (!trimmed) return;
    setLoadingPrompt(true);
    setError(null);
    try {
      const data = await api<{ prompt: string }>("/api/scoping-prompt");
      setPrompt(`${data.prompt}${trimmed}\n`);
      setCopied(false);
      setStep(2);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load prompt template.");
    } finally {
      setLoadingPrompt(false);
    }
  }

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  async function createProject() {
    if (!hasRepoAccess) {
      setError("Connect GitHub first so we can create a repository for this project.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ project_id: string }>("/api/import", {
        method: "POST",
        body: JSON.stringify({
          plan_text: planText,
          test_mode: "skip",
          repo_setup: "create",
          private: privateRepo,
        }),
      });
      onCreated(result.project_id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create project.");
    } finally {
      setBusy(false);
    }
  }

  if (step === 1) {
    return (
      <section className="idea-sheet">
        <header className="idea-sheet-head">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
            Cancel
          </button>
          <h1 className="idea-sheet-title">From an idea</h1>
          <span className="idea-sheet-head-spacer" aria-hidden />
        </header>

        <Stack gap="md" className="idea-sheet-body">
          <p className="idea-sheet-lead">
            Describe what you want to build. We&apos;ll turn it into a prompt for any LLM.
          </p>
          <label className="field">
            Your idea
            <textarea
              value={idea}
              onChange={(event) => setIdea(event.target.value)}
              placeholder="A shared packing list for roommates"
              rows={5}
              autoFocus
            />
          </label>
          <div className="idea-sheet-footer">
            <button
              type="button"
              className="btn btn-primary"
              disabled={!idea.trim() || loadingPrompt}
              onClick={() => void goToPromptStep()}
            >
              {loadingPrompt ? "Preparing…" : "Next"}
            </button>
          </div>
          {error ? <Alert variant="error">{error}</Alert> : null}
        </Stack>
      </section>
    );
  }

  return (
    <section className="idea-sheet idea-sheet--workspace">
      <header className="idea-sheet-head">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setStep(1)}>
          Back
        </button>
        <h1 className="idea-sheet-title">Build the plan</h1>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
          Cancel
        </button>
      </header>

      <div className="idea-workspace">
        <div className="idea-workspace-step">
          <div className="idea-workspace-step-top">
            <span className="idea-workspace-num">1</span>
            <div className="idea-workspace-step-copy">
              <strong>Copy this prompt</strong>
              <span>Paste it into ChatGPT, Claude, or any LLM.</span>
            </div>
            <button
              type="button"
              className={`btn btn-sm${copied ? " btn-primary idea-copied" : " btn-secondary"}`}
              onClick={() => void copyPrompt()}
              aria-live="polite"
            >
              {copied ? "Copied" : "Copy prompt"}
            </button>
          </div>
          <details className="idea-prompt-peek">
            <summary>Preview prompt</summary>
            <pre>{prompt}</pre>
          </details>
        </div>

        <div className="idea-workspace-step idea-workspace-step--paste">
          <div className="idea-workspace-step-top">
            <span className="idea-workspace-num">2</span>
            <div className="idea-workspace-step-copy">
              <strong>Paste the JSON</strong>
              <span>Drop the model&apos;s output here.</span>
            </div>
          </div>
          <textarea
            id="idea-plan-json"
            className="idea-workspace-plan"
            value={planText}
            onChange={(event) => setPlanText(event.target.value)}
            placeholder='{"project_name":"...","features":[...]}'
            autoFocus
          />
        </div>

        <div className="idea-workspace-step">
          <div className="idea-workspace-step-top">
            <span className="idea-workspace-num">3</span>
            <div className="idea-workspace-step-copy">
              <strong>Create on GitHub</strong>
              <span>We make a new repo under your account and open the board.</span>
            </div>
          </div>
          <div className="idea-workspace-create">
            {!hasRepoAccess ? (
              <Alert variant="warn">
                <a href={githubRepoAuthUrl()}>Connect GitHub</a> to create the repository.
              </Alert>
            ) : (
              <label className="idea-private-check">
                <input
                  type="checkbox"
                  checked={privateRepo}
                  onChange={(event) => setPrivateRepo(event.target.checked)}
                  disabled={!hasPrivateRepoAccess}
                />
                Private repository
                {!hasPrivateRepoAccess ? (
                  <span className="muted"> — needs private-repo access</span>
                ) : null}
              </label>
            )}
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !planText.trim() || !hasRepoAccess}
              onClick={() => void createProject()}
            >
              {busy ? "Creating…" : "Create project"}
            </button>
          </div>
        </div>

        {error ? <Alert variant="error">{error}</Alert> : null}
      </div>
    </section>
  );
}
