import type { Repo } from "../db/repo.js";
import { forbidden, notFound } from "../lib/errors.js";
import type { AppEnv, ProjectRow } from "../types.js";
import { requireLiveProject } from "./repo-health.js";

/**
 * The only permission check in the MVP: are you on this project or not.
 * A missing project is reported as forbidden so project ids are not enumerable.
 */
export async function requireMembership(
  repo: Repo,
  projectId: string,
  userId: string,
): Promise<ProjectRow> {
  const project = await repo.getProject(projectId);
  if (!project) throw forbidden(`You do not have access to project ${projectId}.`);
  if (!(await repo.isMember(projectId, userId))) {
    throw forbidden(`You are not a member of project ${projectId}.`);
  }
  return project;
}

/** Membership check plus removal when the linked GitHub repo no longer exists. */
export async function requireLiveMembership(
  env: AppEnv,
  repo: Repo,
  projectId: string,
  userId: string,
): Promise<ProjectRow> {
  const project = await requireMembership(repo, projectId, userId);
  return requireLiveProject(env, repo, project);
}

export async function requireUser(repo: Repo, userId: string) {
  const user = await repo.getUser(userId);
  if (!user) throw notFound("Your VibeHub account no longer exists.");
  return user;
}

/** Resolves a user reference (internal id or GitHub login) within a project. */
export async function resolveMemberId(
  repo: Repo,
  projectId: string,
  reference: string,
): Promise<string | null> {
  const members = await repo.listMembers(projectId);
  const match = members.find(
    (member) => member.id === reference || member.github_login === reference,
  );
  return match?.id ?? null;
}
