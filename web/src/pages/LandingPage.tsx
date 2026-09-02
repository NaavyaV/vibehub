import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ApiError, api, githubLoginUrl, githubRepoAuthUrl } from "../lib/api";
import {
  Alert,
  Card,
  PageHeader,
  Shell,
  Stack,
  EmptyState,
} from "../components/ui";
import { RepoPicker } from "../components/RepoPicker";
import { LocalCodeUpload } from "../components/LocalCodeUpload";
import { IdeaProjectFlow } from "../components/IdeaProjectFlow";
import { AddProjectPrompt } from "../components/AddProjectPrompt";
import { AddProjectPicker } from "../components/AddProjectPicker";
import { ProjectInvitesBanner, type PendingInvite } from "../components/ProjectInvitesBanner";
import type { PushKit } from "../components/AgentPushPanel";
import { PrivateRepoConnect, needsPrivateRepoReconnect } from "../components/PrivateRepoConnect";

type User = {
  id: string;
  display_name: string;
  github_login: string | null;
  avatar_url: string | null;
  has_github_token: boolean;
  has_repo_access: boolean;
  has_private_repo_access: boolean;
  has_mcp_token: boolean;
};

type Project = {
  id: string;
  name: string;
  repo_url: string | null;
  current_version: number;
  role?: string;
};

type Config = {
  public_url: string;
  github_oauth: boolean;
  dev_login: boolean;
  mcp_url: string;
};

type MeResponse = {
  user: User | null;
  mcp_url?: string;
  agent_push_prompt?: string;
  push_kit?: PushKit;
  pending_invites?: PendingInvite[];
};

type View = "home" | "pick" | "agent" | "github" | "idea" | "local";

export function LandingPage() {
  const navigate = useNavigate();
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [config, setConfig] = useState<Config | null>(null);
  const [pushKit, setPushKit] = useState<PushKit | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsReady, setProjectsReady] = useState(false);
  const [view, setView] = useState<View>("home");
  const [repoUrl, setRepoUrl] = useState("");
  const [newRepoName, setNewRepoName] = useState("");
  const [privateRepo, setPrivateRepo] = useState(false);
  const [localFiles, setLocalFiles] = useState<Array<{ path: string; content: string }>>([]);
  const [localPhase, setLocalPhase] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [privateRepoError, setPrivateRepoError] = useState(false);
  const [pendingInvites, setPendingInvites] = useState<PendingInvite[]>([]);
  const [inviteBusy, setInviteBusy] = useState(false);

  async function loadSession() {
    setProjectsReady(false);
    const [me, cfg] = await Promise.all([
      api<MeResponse>("/api/me"),
      api<Config>("/api/config"),
    ]);
    setConfig(cfg);
    setPushKit(me.push_kit ?? null);
    setPendingInvites(me.pending_invites ?? []);
    if (me.user) {
      const list = await api<{ projects: Project[] }>("/api/projects");
      setProjects(list.projects);
      setView("home");
    } else {
      setProjects([]);
    }
    // Mark projects ready and set user in the same turn so we never paint the
    // empty state while /api/projects is still in flight.
    setProjectsReady(true);
    setUser(me.user);
  }

  useEffect(() => {
    void loadSession().catch((err) => {
      setProjects([]);
      setProjectsReady(true);
      setUser(null);
      setError(err instanceof Error ? err.message : "Could not reach the API.");
    });
  }, []);

  // After the user copies the prompt, auto-open the new project when the agent pushes.
  useEffect(() => {
    if (view !== "agent" || !user) return;
    const baseline = new Set(projects.map((p) => p.id));
    let cancelled = false;

    async function poll() {
      if (cancelled) return;
      try {
        const list = await api<{ projects: Project[] }>("/api/projects");
        const added = list.projects.find((p) => !baseline.has(p.id));
        if (added) {
          navigate(`/projects/${added.id}?welcome=1`);
        }
      } catch {
        /* ignore transient errors while waiting */
      }
    }

    void poll();
    const interval = window.setInterval(() => void poll(), 2500);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [view, user, projects, navigate]);

  async function acceptInvite(inviteId: string) {
    setInviteBusy(true);
    setError(null);
    try {
      const result = await api<{ project_id: string }>(`/api/invites/${inviteId}/accept`, {
        method: "POST",
      });
      setPendingInvites((current) => current.filter((invite) => invite.id !== inviteId));
      await loadSession();
      navigate(`/projects/${result.project_id}?welcome=1`);
    } catch (err) {
      setError(formatErr(err));
    } finally {
      setInviteBusy(false);
    }
  }

  async function declineInvite(inviteId: string) {
    setInviteBusy(true);
    setError(null);
    try {
      await api(`/api/invites/${inviteId}/decline`, { method: "POST" });
      setPendingInvites((current) => current.filter((invite) => invite.id !== inviteId));
    } catch (err) {
      setError(formatErr(err));
    } finally {
      setInviteBusy(false);
    }
  }

  async function removeProject(project: Project) {
    const repoNote = project.repo_url
      ? `\n\nGitHub repo ${project.repo_url.replace(/^https:\/\/github\.com\//, "")} will NOT be deleted.`
      : "";
    if (
      !window.confirm(
        `Remove "${project.name}" from VibeHub?${repoNote}\n\nThis cannot be undone.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api(`/api/projects/${project.id}`, { method: "DELETE" });
      setProjects((current) => current.filter((item) => item.id !== project.id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not remove project");
    } finally {
      setBusy(false);
    }
  }

  async function importLocal() {
    setBusy(true);
    setError(null);
    setPrivateRepoError(false);
    let repo: string | null = null;
    try {
      setLocalPhase("Uploading to GitHub…");
      const push = await api<{ repo_url: string }>("/api/projects/from-local/push", {
        method: "POST",
        body: JSON.stringify({
          repo_name: newRepoName,
          private: privateRepo,
          files: localFiles,
        }),
      });
      repo = push.repo_url;
      setLocalPhase("Building task tree…");
      const result = await api<{ project_id: string }>("/api/projects/from-existing", {
        method: "POST",
        body: JSON.stringify({
          repo_url: push.repo_url,
          project_name: newRepoName,
          test_mode: "skip",
        }),
      });
      navigate(`/projects/${result.project_id}?welcome=1`);
    } catch (err) {
      if (repo) {
        setError(
          `${formatErr(err)}\n\nYour code was pushed to ${repo.replace(/^https:\/\/github\.com\//, "")} — you can import it from GitHub instead.`,
        );
      } else {
        setError(formatErr(err));
      }
      setPrivateRepoError(
        err instanceof ApiError && needsPrivateRepoReconnect(err.details, err.message),
      );
    } finally {
      setBusy(false);
      setLocalPhase(null);
    }
  }

  async function importExisting() {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ project_id: string }>("/api/projects/from-existing", {
        method: "POST",
        body: JSON.stringify({ repo_url: repoUrl, test_mode: "skip" }),
      });
      navigate(`/projects/${result.project_id}?welcome=1`);
    } catch (err) {
      setError(formatErr(err));
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    await api("/auth/logout", { method: "POST" });
    setUser(null);
    setProjects([]);
    setProjectsReady(true);
  }

  async function devLogin() {
    setBusy(true);
    setError(null);
    try {
      await api("/auth/dev-login", { method: "POST" });
      await loadSession();
    } catch (err) {
      setError(formatErr(err));
    } finally {
      setBusy(false);
    }
  }

  const pageTitle = useMemo(() => {
    if (!user) return "Ship without the merge fight";
    if (view === "pick") return "Add a project";
    if (view === "agent") return "With AI agent";
    if (view === "github") return "From GitHub";
    if (view === "idea") return "From an idea";
    if (view === "local") return "From this computer";
    return projects.length > 0 ? "Your projects" : "Add your first project";
  }, [user, view, projects.length]);

  if (user === undefined || (user && !projectsReady)) {
    return (
      <Shell>
        <p className="loading-line">Loading…</p>
      </Shell>
    );
  }

  return (
    <Shell user={user} onLogout={user ? () => void logout() : undefined} narrow={!user}>
      {!user ? (
        <Stack gap="lg">
          <div className="landing-hero">
            <p className="eyebrow">For vibecoders</p>
            <h1 className="page-title">Build in parallel. Skip the merge fight.</h1>
            <p className="page-subtitle">
              Tell your AI agent to push your project here — or connect a GitHub repo. VibeHub turns
              it into a task tree your whole team can work from.
            </p>
          </div>

          <div className="auth-card">
            <h2>Sign in to start</h2>
            <p className="auth-copy">One GitHub click. Same flow if you&apos;re new or returning.</p>
            {config?.github_oauth ? (
              <a className="btn btn-primary btn-lg btn-block auth-cta" href={githubLoginUrl()}>
                Continue with GitHub
              </a>
            ) : (
              <Alert variant="warn">GitHub login isn&apos;t configured on this host yet.</Alert>
            )}
            {config?.dev_login ? (
              <button
                type="button"
                className="btn btn-ghost btn-block"
                disabled={busy}
                onClick={() => void devLogin()}
              >
                Demo login
              </button>
            ) : null}
            <ul className="auth-bullets">
              <li>Say &ldquo;Push this to VibeHub&rdquo; to your agent</li>
              <li>Or pick a repo you already have</li>
              <li>Assign work on a visual task tree</li>
            </ul>
          </div>
          {error ? <Alert variant="error">{error}</Alert> : null}
        </Stack>
      ) : (
        <Stack gap="lg" className={view !== "home" && view !== "idea" ? "flow-stage" : undefined}>
          {view !== "idea" ? (
            <PageHeader
              className={view !== "home" ? "page-header--centered" : undefined}
              eyebrow={view === "home" ? `Hi, ${user.display_name}` : undefined}
              title={pageTitle}
              subtitle={
                view === "home"
                  ? projects.length > 0
                    ? "Open a project to assign work, or add another."
                    : "Connect your agent once, then say push this to VibeHub."
                  : undefined
              }
              actions={
                view === "home" ? (
                  <button type="button" className="btn btn-primary" onClick={() => setView("pick")}>
                    Add project
                  </button>
                ) : (
                  <button type="button" className="btn btn-ghost" onClick={() => setView("home")}>
                    Cancel
                  </button>
                )
              }
            />
          ) : null}

          {view === "home" ? (
            <ProjectInvitesBanner
              invites={pendingInvites}
              busy={inviteBusy}
              onAccept={(id) => void acceptInvite(id)}
              onDecline={(id) => void declineInvite(id)}
            />
          ) : null}

          {view === "home" && projects.length > 0 ? (
            <div className="project-grid">
              {projects.map((project) => (
                <article key={project.id} className="project-card">
                  <Link className="project-card-link" to={`/projects/${project.id}`}>
                    <span className="project-card-name">{project.name}</span>
                    <span className="project-card-meta">
                      {project.repo_url
                        ? project.repo_url.replace(/^https:\/\/github\.com\//, "")
                        : "No repo"}{" "}
                      · v{project.current_version}
                    </span>
                  </Link>
                  {project.role === "owner" ? (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm project-card-remove"
                      disabled={busy}
                      title="Remove from VibeHub (GitHub repo stays)"
                      onClick={() => void removeProject(project)}
                    >
                      Remove
                    </button>
                  ) : null}
                </article>
              ))}
            </div>
          ) : null}

          {view === "home" && projectsReady && projects.length === 0 ? (
            <Card>
              <EmptyState
                title="No projects yet"
                description="Push code with your AI agent, import a GitHub repo, or start from an idea."
                action={
                  <button type="button" className="btn btn-primary" onClick={() => setView("pick")}>
                    Add project
                  </button>
                }
              />
              {!user.has_repo_access ? (
                <Alert variant="warn">
                  <a href={githubRepoAuthUrl()}>Connect GitHub</a> first so VibeHub can save your code.
                </Alert>
              ) : null}
            </Card>
          ) : null}

          {view === "pick" ? (
            <Card title="How do you want to add a project?" className="flow-stage-card">
              <AddProjectPicker
                onPick={(id) => setView(id as Exclude<View, "home" | "pick">)}
              />
              {!user.has_repo_access ? (
                <Alert variant="warn">
                  <a href={githubRepoAuthUrl()}>Connect GitHub</a> for repo-based options.
                </Alert>
              ) : null}
            </Card>
          ) : null}

          {view === "agent" ? (
            <Card className="flow-stage-card flow-stage-card--agent">
              <AddProjectPrompt
                pushKit={pushKit}
                hasRepoAccess={user.has_repo_access}
                hasMcpToken={user.has_mcp_token}
                repoAuthUrl={githubRepoAuthUrl()}
                watching
              />
            </Card>
          ) : null}

          {view === "github" ? (
            <Card
              title="From GitHub"
              description="We scan your repo and create a project board."
              className="flow-stage-card"
            >
              <RepoPicker
                enabled={user.has_repo_access}
                hasPrivateRepoAccess={user.has_private_repo_access}
                value={repoUrl}
                onChange={(url) => setRepoUrl(url)}
              />
              <div className="row">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy || !repoUrl.trim() || !user.has_repo_access}
                  onClick={() => void importExisting()}
                >
                  {busy ? "Setting up…" : "Add this repo"}
                </button>
              </div>
              {error ? <Alert variant="error">{error}</Alert> : null}
            </Card>
          ) : null}

          {view === "idea" ? (
            <IdeaProjectFlow
              onCreated={(projectId) => navigate(`/projects/${projectId}?welcome=1`)}
              onCancel={() => setView("home")}
              hasRepoAccess={user.has_repo_access}
              hasPrivateRepoAccess={user.has_private_repo_access}
            />
          ) : null}

          {view === "local" ? (
            <Card
              title="From this computer"
              description="Upload a project folder from your browser."
              className="flow-stage-card"
            >
              <Stack gap="sm">
                <LocalCodeUpload
                  repoName={newRepoName}
                  onRepoNameChange={setNewRepoName}
                  isPrivate={privateRepo}
                  onPrivateChange={setPrivateRepo}
                  hasPrivateRepoAccess={user.has_private_repo_access}
                  disabled={!user.has_repo_access || busy}
                  onFilesReady={(files) => {
                    setLocalFiles(files);
                  }}
                />
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={
                    busy ||
                    !user.has_repo_access ||
                    !newRepoName.trim() ||
                    localFiles.length === 0
                  }
                  onClick={() => void importLocal()}
                >
                  {busy && localPhase ? localPhase : "Upload and create"}
                </button>
              </Stack>
              {error ? (
                <>
                  <Alert variant="error">{error}</Alert>
                  {privateRepoError ? <PrivateRepoConnect /> : null}
                </>
              ) : null}
            </Card>
          ) : null}
        </Stack>
      )}
    </Shell>
  );
}

function formatErr(err: unknown): string {
  if (err instanceof ApiError) {
    if (Array.isArray(err.details)) return `${err.message}\n${err.details.join("\n")}`;
    return err.message;
  }
  return err instanceof Error ? err.message : "Something went wrong.";
}
