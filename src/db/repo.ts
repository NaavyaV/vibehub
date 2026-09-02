/**
 * D1 access layer. Metadata only — no column here ever holds file content.
 */

import { newId, nowIso } from "../lib/ids.js";
import type {
  BlockerRow,
  FeatureRow,
  FeatureStatus,
  ProjectRow,
  ProjectInviteRow,
  PushRow,
  PushStage,
  PushStatus,
  SnapshotRow,
  TestMode,
  UserRow,
  VersionRow,
} from "../types.js";

export interface FeatureWithDeps extends FeatureRow {
  /** Slugs of the features this one depends on. */
  dependsOn: string[];
}

export class Repo {
  constructor(private readonly db: D1Database) {}

  // ---------------------------------------------------------------- users

  async upsertGithubUser(input: {
    githubLogin: string;
    displayName: string;
    avatarUrl: string | null;
    githubTokenEnc: string | null;
  }): Promise<UserRow> {
    const existing = await this.db
      .prepare(`SELECT * FROM users WHERE github_login = ?`)
      .bind(input.githubLogin)
      .first<UserRow>();

    if (existing) {
      await this.db
        .prepare(
          `UPDATE users SET display_name = ?, avatar_url = ?,
             github_token_enc = COALESCE(?, github_token_enc) WHERE id = ?`,
        )
        .bind(input.displayName, input.avatarUrl, input.githubTokenEnc, existing.id)
        .run();
      return { ...existing, display_name: input.displayName, avatar_url: input.avatarUrl };
    }

    const row: UserRow = {
      id: newId("usr"),
      github_login: input.githubLogin,
      display_name: input.displayName,
      avatar_url: input.avatarUrl,
      github_token_enc: input.githubTokenEnc,
      email: null,
      password_hash: null,
      created_at: nowIso(),
    };
    await this.db
      .prepare(
        `INSERT INTO users (id, github_login, display_name, avatar_url, github_token_enc, email, password_hash, created_at)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`,
      )
      .bind(
        row.id,
        row.github_login,
        row.display_name,
        row.avatar_url,
        row.github_token_enc,
        row.created_at,
      )
      .run();
    return row;
  }

  getUser(id: string): Promise<UserRow | null> {
    return this.db.prepare(`SELECT * FROM users WHERE id = ?`).bind(id).first<UserRow>();
  }

  getUserByGithubLogin(login: string): Promise<UserRow | null> {
    return this.db
      .prepare(`SELECT * FROM users WHERE LOWER(github_login) = LOWER(?)`)
      .bind(login.trim())
      .first<UserRow>();
  }

  async setUserGithubToken(userId: string, githubTokenEnc: string): Promise<void> {
    await this.db
      .prepare(`UPDATE users SET github_token_enc = ? WHERE id = ?`)
      .bind(githubTokenEnc, userId)
      .run();
  }

  // ------------------------------------------------------------- projects

  async createProject(input: {
    name: string;
    createdBy: string | null;
    sharedFileWarnings: string[];
    testMode: TestMode;
  }): Promise<ProjectRow> {
    const row: ProjectRow = {
      id: newId("prj"),
      name: input.name,
      repo_url: null,
      storage_provider: "github",
      current_version: 0,
      created_at: nowIso(),
      repo_owner: null,
      repo_name: null,
      default_branch: "main",
      github_token_enc: null,
      test_mode: input.testMode,
      shared_file_warnings: JSON.stringify(input.sharedFileWarnings),
      created_by: input.createdBy,
    };
    await this.db
      .prepare(
        `INSERT INTO projects
           (id, name, repo_url, storage_provider, current_version, created_at, repo_owner,
            repo_name, default_branch, github_token_enc, test_mode, shared_file_warnings, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.id,
        row.name,
        row.repo_url,
        row.storage_provider,
        row.current_version,
        row.created_at,
        row.repo_owner,
        row.repo_name,
        row.default_branch,
        row.github_token_enc,
        row.test_mode,
        row.shared_file_warnings,
        row.created_by,
      )
      .run();
    return row;
  }

  getProject(id: string): Promise<ProjectRow | null> {
    return this.db.prepare(`SELECT * FROM projects WHERE id = ?`).bind(id).first<ProjectRow>();
  }

  async findProjectByRepoUrlForUser(userId: string, repoUrl: string): Promise<ProjectRow | null> {
    const normalized = repoUrl.trim().replace(/\.git$/, "").replace(/\/+$/, "").toLowerCase();
    const projects = await this.listProjectsForUser(userId);
    return (
      projects.find((project) => {
        const url = project.repo_url?.trim().replace(/\.git$/, "").replace(/\/+$/, "").toLowerCase();
        return url === normalized;
      }) ?? null
    );
  }

  async findProjectByRepoNameForUser(userId: string, repoName: string): Promise<ProjectRow | null> {
    const normalized = repoName.trim().toLowerCase();
    const projects = await this.listProjectsForUser(userId);
    return (
      projects.find(
        (project) =>
          project.repo_name?.trim().toLowerCase() === normalized ||
          project.repo_url?.toLowerCase().endsWith(`/${normalized}`),
      ) ?? null
    );
  }

  listProjectsByGithubRepo(owner: string, repoName: string): Promise<ProjectRow[]> {
    return this.db
      .prepare(`SELECT * FROM projects WHERE repo_owner = ? AND repo_name = ?`)
      .bind(owner, repoName)
      .all<ProjectRow>()
      .then((result) => result.results ?? []);
  }

  async listLinkedProjects(): Promise<ProjectRow[]> {
    const result = await this.db
      .prepare(
        `SELECT * FROM projects
         WHERE repo_owner IS NOT NULL AND repo_name IS NOT NULL AND github_token_enc IS NOT NULL`,
      )
      .all<ProjectRow>();
    return result.results ?? [];
  }

  async listProjectsForUser(userId: string): Promise<Array<ProjectRow & { role: string }>> {
    const result = await this.db
      .prepare(
        `SELECT p.*, m.role FROM projects p
         JOIN project_members m ON m.project_id = p.id
         WHERE m.user_id = ? ORDER BY p.created_at DESC`,
      )
      .bind(userId)
      .all<ProjectRow & { role: string }>();
    return result.results ?? [];
  }

  async updateProjectRepo(
    projectId: string,
    input: {
      repoUrl: string;
      repoOwner: string;
      repoName: string;
      defaultBranch: string;
      githubTokenEnc: string;
    },
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE projects SET repo_url = ?, repo_owner = ?, repo_name = ?,
           default_branch = ?, github_token_enc = ? WHERE id = ?`,
      )
      .bind(
        input.repoUrl,
        input.repoOwner,
        input.repoName,
        input.defaultBranch,
        input.githubTokenEnc,
        projectId,
      )
      .run();
  }

  async setTestMode(projectId: string, testMode: TestMode): Promise<void> {
    await this.db
      .prepare(`UPDATE projects SET test_mode = ? WHERE id = ?`)
      .bind(testMode, projectId)
      .run();
  }

  /**
   * Compare-and-swap the project version. Returns false when another push moved
   * the version first, which tells the caller to re-check conflicts and retry.
   */
  async casCurrentVersion(
    projectId: string,
    expected: number,
    next: number,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(`UPDATE projects SET current_version = ? WHERE id = ? AND current_version = ?`)
      .bind(next, projectId, expected)
      .run();
    return (result.meta.changes ?? 0) === 1;
  }

  // -------------------------------------------------------------- members

  async addMember(projectId: string, userId: string, role = "member"): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO project_members (project_id, user_id, role, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(projectId, userId, role, nowIso())
      .run();
  }

  async isMember(projectId: string, userId: string): Promise<boolean> {
    const row = await this.db
      .prepare(`SELECT 1 AS ok FROM project_members WHERE project_id = ? AND user_id = ?`)
      .bind(projectId, userId)
      .first<{ ok: number }>();
    return row !== null;
  }

  async listMembers(projectId: string): Promise<Array<UserRow & { role: string }>> {
    const result = await this.db
      .prepare(
        `SELECT u.*, m.role FROM users u
         JOIN project_members m ON m.user_id = u.id
         WHERE m.project_id = ? ORDER BY m.created_at`,
      )
      .bind(projectId)
      .all<UserRow & { role: string }>();
    return result.results ?? [];
  }

  async getMemberRole(projectId: string, userId: string): Promise<string | null> {
    const row = await this.db
      .prepare(`SELECT role FROM project_members WHERE project_id = ? AND user_id = ?`)
      .bind(projectId, userId)
      .first<{ role: string }>();
    return row?.role ?? null;
  }

  async removeMember(projectId: string, userId: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM project_members WHERE project_id = ? AND user_id = ?`)
      .bind(projectId, userId)
      .run();
  }

  // ------------------------------------------------------------- invites

  async createProjectInvite(input: {
    projectId: string;
    inviteeUserId: string;
    invitedBy: string;
    role: string;
  }): Promise<ProjectInviteRow> {
    const pending = await this.getPendingInvite(input.projectId, input.inviteeUserId);
    if (pending) {
      throw new Error("INVITE_PENDING");
    }
    const id = newId("inv");
    const timestamp = nowIso();
    await this.db
      .prepare(
        `INSERT INTO project_invites
           (id, project_id, invitee_user_id, invited_by, role, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .bind(id, input.projectId, input.inviteeUserId, input.invitedBy, input.role, timestamp)
      .run();
    return {
      id,
      project_id: input.projectId,
      invitee_user_id: input.inviteeUserId,
      invited_by: input.invitedBy,
      role: input.role,
      status: "pending",
      created_at: timestamp,
      responded_at: null,
    };
  }

  async getPendingInvite(
    projectId: string,
    inviteeUserId: string,
  ): Promise<ProjectInviteRow | null> {
    return (
      (await this.db
        .prepare(
          `SELECT * FROM project_invites
           WHERE project_id = ? AND invitee_user_id = ? AND status = 'pending'`,
        )
        .bind(projectId, inviteeUserId)
        .first<ProjectInviteRow>()) ?? null
    );
  }

  async getInvite(inviteId: string): Promise<ProjectInviteRow | null> {
    return (
      (await this.db.prepare(`SELECT * FROM project_invites WHERE id = ?`).bind(inviteId).first<ProjectInviteRow>()) ??
      null
    );
  }

  async listInvitesForUser(userId: string): Promise<
    Array<
      ProjectInviteRow & {
        project_name: string;
        inviter_name: string;
        inviter_github: string | null;
      }
    >
  > {
    const result = await this.db
      .prepare(
        `SELECT i.*, p.name AS project_name, u.display_name AS inviter_name, u.github_login AS inviter_github
         FROM project_invites i
         JOIN projects p ON p.id = i.project_id
         JOIN users u ON u.id = i.invited_by
         WHERE i.invitee_user_id = ? AND i.status = 'pending'
         ORDER BY i.created_at DESC`,
      )
      .bind(userId)
      .all<
        ProjectInviteRow & {
          project_name: string;
          inviter_name: string;
          inviter_github: string | null;
        }
      >();
    return result.results ?? [];
  }

  async listPendingInvitesForProject(projectId: string): Promise<
    Array<
      ProjectInviteRow & {
        invitee_name: string;
        invitee_github: string | null;
        invitee_avatar: string | null;
      }
    >
  > {
    const result = await this.db
      .prepare(
        `SELECT i.*, u.display_name AS invitee_name, u.github_login AS invitee_github, u.avatar_url AS invitee_avatar
         FROM project_invites i
         JOIN users u ON u.id = i.invitee_user_id
         WHERE i.project_id = ? AND i.status = 'pending'
         ORDER BY i.created_at`,
      )
      .bind(projectId)
      .all<
        ProjectInviteRow & {
          invitee_name: string;
          invitee_github: string | null;
          invitee_avatar: string | null;
        }
      >();
    return result.results ?? [];
  }

  async respondToInvite(
    inviteId: string,
    status: "accepted" | "declined",
  ): Promise<ProjectInviteRow | null> {
    const timestamp = nowIso();
    const result = await this.db
      .prepare(
        `UPDATE project_invites SET status = ?, responded_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .bind(status, timestamp, inviteId)
      .run();
    if ((result.meta.changes ?? 0) === 0) return null;
    return this.getInvite(inviteId);
  }

  async deleteProject(projectId: string): Promise<void> {
    await this.db.prepare(`DELETE FROM projects WHERE id = ?`).bind(projectId).run();
  }

  // ------------------------------------------------------------- features

  async insertFeatures(
    projectId: string,
    features: Array<{
      slug: string;
      title: string;
      description: string;
      scopeNotes: string;
      manifest: unknown;
      testSpec: string | null;
      status: FeatureStatus;
      assignedTo?: string | null;
      position: number;
    }>,
  ): Promise<Map<string, string>> {
    const timestamp = nowIso();
    const slugToId = new Map<string, string>();
    const statements: D1PreparedStatement[] = [];

    for (const feature of features) {
      const id = newId("ftr");
      slugToId.set(feature.slug, id);
      statements.push(
        this.db
          .prepare(
            `INSERT INTO features
               (id, project_id, slug, title, description, status, assigned_to, scope_notes,
                manifest, test_spec, position, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            id,
            projectId,
            feature.slug,
            feature.title,
            feature.description,
            feature.status,
            feature.assignedTo ?? null,
            feature.scopeNotes,
            JSON.stringify(feature.manifest),
            feature.testSpec,
            feature.position,
            timestamp,
            timestamp,
          ),
      );
    }

    if (statements.length > 0) await this.db.batch(statements);
    return slugToId;
  }

  async listFeatures(projectId: string): Promise<FeatureRow[]> {
    const result = await this.db
      .prepare(`SELECT * FROM features WHERE project_id = ? ORDER BY position, slug`)
      .bind(projectId)
      .all<FeatureRow>();
    return result.results ?? [];
  }

  async listFeaturesWithDeps(projectId: string): Promise<FeatureWithDeps[]> {
    const features = await this.listFeatures(projectId);
    const edges = await this.listDependencies(projectId);
    const byId = new Map(features.map((f) => [f.id, f]));
    const depsById = new Map<string, string[]>();
    for (const edge of edges) {
      const slug = byId.get(edge.depends_on_feature_id)?.slug;
      if (!slug) continue;
      const list = depsById.get(edge.feature_id) ?? [];
      list.push(slug);
      depsById.set(edge.feature_id, list);
    }
    return features.map((feature) => ({
      ...feature,
      dependsOn: (depsById.get(feature.id) ?? []).sort(),
    }));
  }

  /** Accepts either the internal id or the plan slug. */
  async findFeature(projectId: string, idOrSlug: string): Promise<FeatureRow | null> {
    return this.db
      .prepare(`SELECT * FROM features WHERE project_id = ? AND (id = ? OR slug = ?)`)
      .bind(projectId, idOrSlug, idOrSlug)
      .first<FeatureRow>();
  }

  async updateFeature(
    featureId: string,
    fields: Partial<{
      title: string;
      description: string;
      status: FeatureStatus;
      assigned_to: string | null;
      scope_notes: string;
      manifest: string;
      test_spec: string | null;
      slug: string;
      position: number;
    }>,
  ): Promise<void> {
    const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
    if (entries.length === 0) return;
    const assignments = entries.map(([key]) => `${key} = ?`).join(", ");
    await this.db
      .prepare(`UPDATE features SET ${assignments}, updated_at = ? WHERE id = ?`)
      .bind(...entries.map(([, value]) => value as string), nowIso(), featureId)
      .run();
  }

  /**
   * `versions.created_by_feature_id` has no ON DELETE rule, so any task that ever
   * shipped is pinned by a foreign key. Detach the version rows (history is kept)
   * before removing the feature.
   */
  async deleteFeature(featureId: string): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(`UPDATE versions SET created_by_feature_id = NULL WHERE created_by_feature_id = ?`)
        .bind(featureId),
      this.db.prepare(`UPDATE snapshots SET feature_id = NULL WHERE feature_id = ?`).bind(featureId),
      this.db.prepare(`DELETE FROM blockers WHERE feature_id = ?`).bind(featureId),
      this.db.prepare(`DELETE FROM pushes WHERE feature_id = ?`).bind(featureId),
      this.db.prepare(`DELETE FROM feature_dependencies WHERE feature_id = ?`).bind(featureId),
      this.db
        .prepare(`DELETE FROM feature_dependencies WHERE depends_on_feature_id = ?`)
        .bind(featureId),
      this.db.prepare(`DELETE FROM features WHERE id = ?`).bind(featureId),
    ]);
  }

  // --------------------------------------------------------- dependencies

  async listDependencies(
    projectId: string,
  ): Promise<Array<{ feature_id: string; depends_on_feature_id: string }>> {
    const result = await this.db
      .prepare(
        `SELECT d.feature_id, d.depends_on_feature_id FROM feature_dependencies d
         JOIN features f ON f.id = d.feature_id
         WHERE f.project_id = ?`,
      )
      .bind(projectId)
      .all<{ feature_id: string; depends_on_feature_id: string }>();
    return result.results ?? [];
  }

  async replaceDependencies(featureId: string, dependsOnIds: string[]): Promise<void> {
    const statements: D1PreparedStatement[] = [
      this.db.prepare(`DELETE FROM feature_dependencies WHERE feature_id = ?`).bind(featureId),
    ];
    for (const dependsOn of dependsOnIds) {
      statements.push(
        this.db
          .prepare(
            `INSERT OR IGNORE INTO feature_dependencies (feature_id, depends_on_feature_id)
             VALUES (?, ?)`,
          )
          .bind(featureId, dependsOn),
      );
    }
    await this.db.batch(statements);
  }

  async insertDependencyEdges(edges: Array<{ featureId: string; dependsOnId: string }>): Promise<void> {
    if (edges.length === 0) return;
    await this.db.batch(
      edges.map((edge) =>
        this.db
          .prepare(
            `INSERT OR IGNORE INTO feature_dependencies (feature_id, depends_on_feature_id)
             VALUES (?, ?)`,
          )
          .bind(edge.featureId, edge.dependsOnId),
      ),
    );
  }

  // ------------------------------------------------------------- versions

  async insertVersion(input: {
    projectId: string;
    versionNumber: number;
    commitSha: string | null;
    createdByFeatureId: string | null;
    changedPaths: string[];
  }): Promise<VersionRow> {
    const row: VersionRow = {
      id: newId("ver"),
      project_id: input.projectId,
      version_number: input.versionNumber,
      commit_sha: input.commitSha,
      created_by_feature_id: input.createdByFeatureId,
      changed_paths: JSON.stringify(input.changedPaths),
      created_at: nowIso(),
    };
    await this.db
      .prepare(
        `INSERT INTO versions
           (id, project_id, version_number, commit_sha, created_by_feature_id, changed_paths, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.id,
        row.project_id,
        row.version_number,
        row.commit_sha,
        row.created_by_feature_id,
        row.changed_paths,
        row.created_at,
      )
      .run();
    return row;
  }

  async setVersionCommit(projectId: string, versionNumber: number, commitSha: string): Promise<void> {
    await this.db
      .prepare(`UPDATE versions SET commit_sha = ? WHERE project_id = ? AND version_number = ?`)
      .bind(commitSha, projectId, versionNumber)
      .run();
  }

  async listVersions(projectId: string): Promise<VersionRow[]> {
    const result = await this.db
      .prepare(`SELECT * FROM versions WHERE project_id = ? ORDER BY version_number DESC`)
      .bind(projectId)
      .all<VersionRow>();
    return result.results ?? [];
  }

  /** Only used to back out a version row when the version CAS loses a race. */
  async deleteVersion(projectId: string, versionNumber: number): Promise<void> {
    await this.db
      .prepare(`DELETE FROM versions WHERE project_id = ? AND version_number = ?`)
      .bind(projectId, versionNumber)
      .run();
  }

  getVersion(projectId: string, versionNumber: number): Promise<VersionRow | null> {
    return this.db
      .prepare(`SELECT * FROM versions WHERE project_id = ? AND version_number = ?`)
      .bind(projectId, versionNumber)
      .first<VersionRow>();
  }

  // --------------------------------------------------------------- pushes

  async createPush(input: {
    projectId: string;
    featureId: string;
    basedOnVersion: number;
    changedPaths: string[];
    notes: string | null;
    callbackTokenHash: string | null;
    webhookUrl: string | null;
    createdBy: string | null;
  }): Promise<PushRow> {
    const timestamp = nowIso();
    const row: PushRow = {
      id: newId("psh"),
      project_id: input.projectId,
      feature_id: input.featureId,
      based_on_version: input.basedOnVersion,
      status: "testing",
      stage: "queued",
      changed_paths: JSON.stringify(input.changedPaths),
      conflict_paths: "[]",
      conflict_reason: null,
      staging_ref: null,
      commit_sha: null,
      merged_version: null,
      build_output: null,
      error: null,
      notes: input.notes,
      callback_token_hash: input.callbackTokenHash,
      webhook_url: input.webhookUrl,
      created_by: input.createdBy,
      created_at: timestamp,
      updated_at: timestamp,
    };
    await this.db
      .prepare(
        `INSERT INTO pushes
           (id, project_id, feature_id, based_on_version, status, stage, changed_paths,
            conflict_paths, conflict_reason, staging_ref, commit_sha, merged_version,
            build_output, error, notes, callback_token_hash, webhook_url, created_by,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.id,
        row.project_id,
        row.feature_id,
        row.based_on_version,
        row.status,
        row.stage,
        row.changed_paths,
        row.conflict_paths,
        row.conflict_reason,
        row.staging_ref,
        row.commit_sha,
        row.merged_version,
        row.build_output,
        row.error,
        row.notes,
        row.callback_token_hash,
        row.webhook_url,
        row.created_by,
        row.created_at,
        row.updated_at,
      )
      .run();
    return row;
  }

  getPush(pushId: string): Promise<PushRow | null> {
    return this.db.prepare(`SELECT * FROM pushes WHERE id = ?`).bind(pushId).first<PushRow>();
  }

  async updatePush(
    pushId: string,
    fields: Partial<{
      status: PushStatus;
      stage: PushStage;
      conflict_paths: string;
      conflict_reason: string | null;
      staging_ref: string | null;
      commit_sha: string | null;
      merged_version: number | null;
      build_output: string | null;
      error: string | null;
      callback_token_hash: string | null;
    }>,
  ): Promise<void> {
    const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
    if (entries.length === 0) return;
    const assignments = entries.map(([key]) => `${key} = ?`).join(", ");
    await this.db
      .prepare(`UPDATE pushes SET ${assignments}, updated_at = ? WHERE id = ?`)
      .bind(...entries.map(([, value]) => value as string | number | null), nowIso(), pushId)
      .run();
  }

  async listPushes(projectId: string, limit = 50): Promise<PushRow[]> {
    const result = await this.db
      .prepare(`SELECT * FROM pushes WHERE project_id = ? ORDER BY created_at DESC LIMIT ?`)
      .bind(projectId, limit)
      .all<PushRow>();
    return result.results ?? [];
  }

  // ------------------------------------------------------------ snapshots

  async createSnapshot(input: {
    projectId: string;
    featureId: string | null;
    description: string;
    storageRef: string;
    createdBy: string | null;
  }): Promise<SnapshotRow> {
    const row: SnapshotRow = {
      id: newId("snp"),
      project_id: input.projectId,
      feature_id: input.featureId,
      description: input.description,
      storage_ref: input.storageRef,
      created_by: input.createdBy,
      created_at: nowIso(),
    };
    await this.db
      .prepare(
        `INSERT INTO snapshots (id, project_id, feature_id, description, storage_ref, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.id,
        row.project_id,
        row.feature_id,
        row.description,
        row.storage_ref,
        row.created_by,
        row.created_at,
      )
      .run();
    return row;
  }

  async updateSnapshotRef(snapshotId: string, storageRef: string): Promise<void> {
    await this.db
      .prepare(`UPDATE snapshots SET storage_ref = ? WHERE id = ?`)
      .bind(storageRef, snapshotId)
      .run();
  }

  async listSnapshots(projectId: string): Promise<SnapshotRow[]> {
    const result = await this.db
      .prepare(`SELECT * FROM snapshots WHERE project_id = ? ORDER BY created_at DESC`)
      .bind(projectId)
      .all<SnapshotRow>();
    return result.results ?? [];
  }

  // ------------------------------------------------------------- blockers

  async createBlocker(input: {
    projectId: string;
    featureId: string;
    reason: string;
    reportedBy: string | null;
  }): Promise<BlockerRow> {
    const row: BlockerRow = {
      id: newId("blk"),
      project_id: input.projectId,
      feature_id: input.featureId,
      reason: input.reason,
      reported_by: input.reportedBy,
      created_at: nowIso(),
      resolved_at: null,
    };
    await this.db
      .prepare(
        `INSERT INTO blockers (id, project_id, feature_id, reason, reported_by, created_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      )
      .bind(row.id, row.project_id, row.feature_id, row.reason, row.reported_by, row.created_at)
      .run();
    return row;
  }

  async listOpenBlockers(projectId: string): Promise<BlockerRow[]> {
    const result = await this.db
      .prepare(
        `SELECT * FROM blockers WHERE project_id = ? AND resolved_at IS NULL ORDER BY created_at DESC`,
      )
      .bind(projectId)
      .all<BlockerRow>();
    return result.results ?? [];
  }

  async resolveBlocker(blockerId: string): Promise<void> {
    await this.db
      .prepare(`UPDATE blockers SET resolved_at = ? WHERE id = ?`)
      .bind(nowIso(), blockerId)
      .run();
  }

  // ----------------------------------------------------------- api tokens

  async createApiToken(input: {
    userId: string;
    name: string;
    tokenHash: string;
  }): Promise<{ id: string }> {
    const id = newId("tok");
    await this.db
      .prepare(
        `INSERT INTO api_tokens (id, user_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(id, input.userId, input.name, input.tokenHash, nowIso())
      .run();
    return { id };
  }

  async findApiToken(tokenHash: string): Promise<{ id: string; user_id: string } | null> {
    return this.db
      .prepare(
        `SELECT id, user_id FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL`,
      )
      .bind(tokenHash)
      .first<{ id: string; user_id: string }>();
  }

  async touchApiToken(id: string): Promise<void> {
    await this.db
      .prepare(`UPDATE api_tokens SET last_used_at = ? WHERE id = ?`)
      .bind(nowIso(), id)
      .run();
  }

  async listApiTokens(
    userId: string,
  ): Promise<Array<{ id: string; name: string; created_at: string; last_used_at: string | null }>> {
    const result = await this.db
      .prepare(
        `SELECT id, name, created_at, last_used_at FROM api_tokens
         WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`,
      )
      .bind(userId)
      .all<{ id: string; name: string; created_at: string; last_used_at: string | null }>();
    return result.results ?? [];
  }

  getApiToken(userId: string, id: string): Promise<{ id: string; name: string } | null> {
    return this.db
      .prepare(
        `SELECT id, name FROM api_tokens WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
      )
      .bind(id, userId)
      .first<{ id: string; name: string }>();
  }

  async revokeApiToken(userId: string, id: string): Promise<void> {
    await this.db
      .prepare(`UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND user_id = ?`)
      .bind(nowIso(), id, userId)
      .run();
  }
}

export function parseJsonArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}
