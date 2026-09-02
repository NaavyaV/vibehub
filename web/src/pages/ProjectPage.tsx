import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ApiError, api, githubLoginUrl } from "../lib/api";
import { TaskGraph } from "../components/TaskGraph";
import { ProjectProgressHero } from "../components/ProjectProgressHero";
import { WhatsShippedFeed } from "../components/WhatsShippedFeed";
import { YourTasks } from "../components/YourTasks";
import { AddProjectPrompt } from "../components/AddProjectPrompt";
import type { PushKit } from "../components/AgentPushPanel";
import { Alert, Card, PageHeader, Shell, Stack, Tabs } from "../components/ui";
import { RepoPicker } from "../components/RepoPicker";

type User = {
  id: string;
  display_name: string;
  github_login: string | null;
  avatar_url: string | null;
  has_repo_access: boolean;
  has_private_repo_access: boolean;
  has_mcp_token: boolean;
};

type VersionRow = {
  version: number;
  commit_sha: string | null;
  created_by_feature: string | null;
  changed_paths: string[];
  created_at: string;
};

type PushRow = {
  push_id: string;
  feature_id: string;
  status: string;
  stage: string;
  based_on_version: number;
  merged_version: number | null;
  changed_paths: string[];
  error: string | null;
  created_at: string;
  created_by: string | null;
  created_by_name: string | null;
  created_by_github: string | null;
  created_by_avatar: string | null;
};

type Board = {
  viewer: { role: string };
  project: {
    id: string;
    name: string;
    repo_url: string | null;
    current_version: number;
    default_branch: string;
    test_mode: string;
    shared_file_warnings: string[];
  };
  features: Array<{
    id: string;
    title: string;
    description: string;
    status: string;
    assigned_to: string | null;
    assigned_name: string | null;
    assigned_github: string | null;
    assigned_avatar: string | null;
    scope_notes: string;
    depends_on: string[];
    blocked_by: string[];
  }>;
  members: Array<{
    id: string;
    display_name: string;
    github_login: string | null;
    avatar_url: string | null;
    role: string;
  }>;
  pending_invites: Array<{
    id: string;
    invitee_id: string;
    invitee_name: string;
    invitee_github: string | null;
    invitee_avatar: string | null;
    role: string;
    created_at: string;
  }>;
  mcp: {
    url: string;
    has_token: boolean;
    tokens: Array<{ id: string; name: string; created_at: string; last_used_at?: string | null }>;
  };
  push_kit: PushKit;
  versions: VersionRow[];
  pushes: PushRow[];
};

type SecondaryTab = "team" | "agent";

export function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [user, setUser] = useState<User | null>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [repoUrl, setRepoUrl] = useState("");
  const [inviteLogin, setInviteLogin] = useState("");
  const [busy, setBusy] = useState(false);
  const [secondaryTab, setSecondaryTab] = useState<SecondaryTab | null>(null);

  const isWelcome = params.get("welcome") === "1";

  async function refresh() {
    if (!id) return;
    const [me, data] = await Promise.all([
      api<{ user: User | null }>("/api/me"),
      api<Board>(`/api/projects/${id}/board`),
    ]);
    if (!me.user) {
      window.location.href = githubLoginUrl(window.location.href);
      return;
    }
    setUser(me.user);
    setBoard(data);
    setRepoUrl(data.project.repo_url ?? "");
  }

  useEffect(() => {
    void refresh().catch((err) => setError(err instanceof Error ? err.message : "Failed to load"));
  }, [id]);

  async function assign(featureId: string, userId: string | null) {
    if (!id) return;
    await api(`/api/projects/${id}/features/${featureId}`, {
      method: "PATCH",
      body: JSON.stringify({ assignedTo: userId }),
    });
    await refresh();
  }

  async function setStatus(featureId: string, status: string) {
    if (!id) return;
    await api(`/api/projects/${id}/features/${featureId}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
    await refresh();
  }

  async function addTask(input: {
    slug: string;
    title: string;
    description: string;
    dependsOn: string[];
    assignedTo: string;
  }) {
    if (!id) return;
    await api(`/api/projects/${id}/features`, {
      method: "POST",
      body: JSON.stringify({
        slug: input.slug,
        title: input.title,
        description: input.description,
        dependsOn: input.dependsOn,
        assignedTo: input.assignedTo,
      }),
    });
    await refresh();
  }

  async function updateTask(
    featureId: string,
    input: { title: string; description: string; dependsOn: string[] },
  ) {
    if (!id) return;
    await api(`/api/projects/${id}/features/${featureId}`, {
      method: "PATCH",
      body: JSON.stringify({
        title: input.title,
        description: input.description,
        dependsOn: input.dependsOn,
      }),
    });
    await refresh();
  }

  async function deleteTask(featureId: string) {
    if (!id || !window.confirm("Delete this task?")) return;
    await api(`/api/projects/${id}/features/${featureId}`, { method: "DELETE" });
    await refresh();
  }

  async function connectRepo() {
    if (!id || !repoUrl.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/projects/${id}/repo`, {
        method: "POST",
        body: JSON.stringify({ repo_url: repoUrl }),
      });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not connect repo");
    } finally {
      setBusy(false);
    }
  }

  async function inviteMember() {
    if (!id || !inviteLogin.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/projects/${id}/members`, {
        method: "POST",
        body: JSON.stringify({ github_login: inviteLogin.trim() }),
      });
      setInviteLogin("");
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not invite member");
    } finally {
      setBusy(false);
    }
  }

  async function removeMember(memberId: string) {
    if (!id || !window.confirm("Remove this member from the project?")) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/projects/${id}/members/${memberId}`, { method: "DELETE" });
      if (memberId === user?.id) {
        navigate("/");
        return;
      }
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not remove member");
    } finally {
      setBusy(false);
    }
  }

  async function deleteProject() {
    if (!id) return;
    const name = board?.project.name ?? "this project";
    const repoNote = board?.project.repo_url
      ? `\n\nYour GitHub repo (${board.project.repo_url.replace(/^https:\/\/github\.com\//, "")}) will NOT be deleted.`
      : "";
    if (
      !window.confirm(
        `Remove "${name}" from VibeHub? This deletes tasks, versions, and push history here.${repoNote}\n\nThis cannot be undone.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api(`/api/projects/${id}`, { method: "DELETE" });
      navigate("/");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not delete project");
    } finally {
      setBusy(false);
    }
  }

  const latestActivity = useMemo(() => {
    if (!board?.pushes[0]) return null;
    const push = board.pushes[0];
    if (push.status === "pending" || push.status === "running") {
      const task = board.features.find((f) => f.id === push.feature_id)?.title ?? push.feature_id;
      return `Right now: testing “${task}” before it goes live.`;
    }
    return null;
  }, [board]);

  if (!board || !user) {
    return (
      <Shell>
        <p className="loading-line">{error ?? "Loading project…"}</p>
      </Shell>
    );
  }

  const hasRepo = Boolean(board.project.repo_url);
  const isOwner = board.viewer.role === "owner";
  const currentVersion = board.project.current_version;
  const myPendingTasks = board.features.filter(
    (f) => f.assigned_to === user.id && f.status !== "done" && f.status !== "merged",
  );
  const showYourTasksBar =
    myPendingTasks.length > 0 ||
    board.features.some(
      (f) => !f.assigned_to && (f.status === "assigned" || f.status === "available"),
    );

  return (
    <Shell
      user={user}
      onLogout={() => {
        void api("/auth/logout", { method: "POST" }).then(() => {
          window.location.href = "/";
        });
      }}
    >
      <Stack gap="lg">
        <PageHeader
          back={{ to: "/", label: "All projects" }}
          title={board.project.name}
          titleHref={board.project.repo_url}
        />

        {isWelcome ? (
          <Card className="welcome-banner">
            <Stack gap="sm">
              <h2 className="section-title">Welcome — here&apos;s your project board</h2>
              <p className="section-desc section-desc--tight">
                Add tasks in plain English. When something ships and passes testing, it moves to
                &ldquo;done&rdquo; and becomes a new live version.
              </p>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  params.delete("welcome");
                  setParams(params, { replace: true });
                }}
              >
                Got it
              </button>
            </Stack>
          </Card>
        ) : null}

        {board.project.shared_file_warnings.length > 0 ? (
          <Alert variant="warn">{board.project.shared_file_warnings.join(" ")}</Alert>
        ) : null}

        {!hasRepo ? (
          <Card title="Connect a GitHub repo">
            <Stack gap="sm">
              <p className="muted">Optional — link a repo so finished work lands on GitHub too.</p>
              <RepoPicker
                value={repoUrl}
                onChange={(url) => setRepoUrl(url)}
                enabled={user.has_repo_access}
                hasPrivateRepoAccess={user.has_private_repo_access}
              />
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy || !repoUrl.trim()}
                onClick={() => void connectRepo()}
              >
                Connect repo
              </button>
            </Stack>
          </Card>
        ) : null}

        <ProjectProgressHero
          features={board.features}
          currentVersion={currentVersion}
          latestActivity={latestActivity}
        />

        <Card className="shipped-feed-card">
          <WhatsShippedFeed
            pushes={board.pushes}
            features={board.features}
            currentVersion={currentVersion}
          />
        </Card>

        {showYourTasksBar ? (
          <Card className="your-tasks-card your-tasks-card-compact">
            <YourTasks features={board.features} meId={user.id} />
          </Card>
        ) : null}

        <Card title="Task plan" description="Click a task to edit or assign. Yours are marked and sorted to the top.">
          <TaskGraph
            features={board.features}
            members={board.members}
            meId={user.id}
            onAssign={(featureId, userId) => void assign(featureId, userId)}
            onStatus={(featureId, status) => void setStatus(featureId, status)}
            onAdd={addTask}
            onUpdate={updateTask}
            onDelete={deleteTask}
          />
        </Card>

        <details className="project-more">
          <summary>Team & agent settings</summary>
          <Stack gap="sm">
            <Tabs
              tabs={[
                { id: "team", label: "Team" },
                { id: "agent", label: "Push with AI" },
              ]}
              active={secondaryTab ?? "team"}
              onChange={(next) => setSecondaryTab(next as SecondaryTab)}
            />

            {(secondaryTab === null || secondaryTab === "team") ? (
              <Stack gap="sm">
                <Card title="People on this project">
                  <ul className="member-list">
                    {board.members.map((member) => (
                      <li key={member.id} className="member-row">
                        <div className="member-info">
                          {member.avatar_url ? <img src={member.avatar_url} alt="" /> : null}
                          <div>
                            <strong>{member.display_name}</strong>
                            {member.github_login ? (
                              <span className="muted"> @{member.github_login}</span>
                            ) : null}
                            <span className="pill">{member.role}</span>
                          </div>
                        </div>
                        {(isOwner && member.id !== user.id) || member.id === user.id ? (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            disabled={busy}
                            onClick={() => void removeMember(member.id)}
                          >
                            {member.id === user.id ? "Leave" : "Remove"}
                          </button>
                        ) : null}
                      </li>
                    ))}
                    {board.pending_invites.map((invite) => (
                      <li key={invite.id} className="member-row member-row-pending">
                        <div className="member-info">
                          {invite.invitee_avatar ? (
                            <img src={invite.invitee_avatar} alt="" />
                          ) : null}
                          <div>
                            <strong>{invite.invitee_name}</strong>
                            {invite.invitee_github ? (
                              <span className="muted"> @{invite.invitee_github}</span>
                            ) : null}
                            <span className="pill pill-warn">Invite pending</span>
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                </Card>

                {isOwner ? (
                  <Card title="Invite someone">
                    <Stack gap="sm">
                      <p className="muted">
                        They&apos;ll get an invite on their home page to accept — they must sign in to
                        VibeHub first.
                      </p>
                      <div className="row">
                        <input
                          type="text"
                          placeholder="GitHub username"
                          value={inviteLogin}
                          onChange={(event) => setInviteLogin(event.target.value)}
                          aria-label="GitHub username"
                        />
                        <button
                          type="button"
                          className="btn btn-primary"
                          disabled={busy || !inviteLogin.trim()}
                          onClick={() => void inviteMember()}
                        >
                          Send invite
                        </button>
                      </div>
                    </Stack>
                  </Card>
                ) : null}
              </Stack>
            ) : null}

            {secondaryTab === "agent" ? (
              <Card title="Push updates with your agent">
                <AddProjectPrompt
                  pushKit={board.push_kit}
                  hasRepoAccess={user.has_repo_access}
                  hasMcpToken={board.mcp.has_token}
                  mode="feature"
                />
              </Card>
            ) : null}
          </Stack>
        </details>

        {isOwner ? (
          <Card title="Remove from VibeHub" className="danger-card">
            <Stack gap="sm">
              <p className="muted">
                Removes this project, its tasks, versions, and history from VibeHub only.
                {hasRepo ? (
                  <>
                    {" "}
                    Your GitHub repo{" "}
                    <strong>{board.project.repo_url!.replace(/^https:\/\/github\.com\//, "")}</strong>{" "}
                    stays exactly as-is — nothing is deleted on GitHub.
                  </>
                ) : (
                  " No GitHub repo is linked."
                )}
              </p>
              <button
                type="button"
                className="btn btn-danger"
                disabled={busy}
                onClick={() => void deleteProject()}
              >
                Remove project from VibeHub
              </button>
            </Stack>
          </Card>
        ) : null}

        {error ? <Alert variant="error">{error}</Alert> : null}
      </Stack>
    </Shell>
  );
}
