/**
 * Import an existing GitHub repo: list paths, heuristically build a task tree,
 * optionally hand the user a one-shot prompt to refine with their own LLM.
 */

import { Repo } from "../db/repo.js";
import { GitHubClient, parseRepoUrl } from "../github/client.js";
import { encryptSecret } from "../lib/crypto.js";
import { badRequest } from "../lib/errors.js";
import { formatTreeForPrompt, inferFeaturesFromPaths } from "../domain/heuristic.js";
import { existingRepoScopingPrompt } from "../ui/scoping-prompt.js";
import type { ImportedPlan } from "../domain/import.js";
import { normalizeManifest } from "../domain/manifest.js";
import { importPlan } from "./projects.js";
import { requireEncryptionKey } from "./github.js";
import type { AppEnv, TestMode } from "../types.js";

export async function importExistingRepo(
  env: AppEnv,
  repo: Repo,
  input: {
    repoUrl: string;
    githubToken: string;
    userId: string;
    testMode?: TestMode;
    projectName?: string;
  },
) {
  const ref = parseRepoUrl(input.repoUrl);
  if (!ref) {
    throw badRequest(
      "That doesn't look like a GitHub repo. Try https://github.com/owner/repo or owner/repo.",
    );
  }

  const repoUrl = `https://github.com/${ref.owner}/${ref.repo}`;
  const existingProject = await repo.findProjectByRepoUrlForUser(input.userId, repoUrl);
  if (existingProject) {
    const features = await repo.listFeatures(existingProject.id);
    const treeListing = "";
    const refinePrompt = existingRepoScopingPrompt({
      projectName: existingProject.name,
      repoUrl,
      treeListing,
    });
    return {
      project_id: existingProject.id,
      name: existingProject.name,
      feature_count: features.length,
      features: features.map((feature) => ({
        id: feature.slug,
        title: feature.title,
        scope_notes: feature.scope_notes,
      })),
      refine_prompt: refinePrompt,
      path_count: 0,
      already_exists: true,
    };
  }

  const client = new GitHubClient(input.githubToken, ref);
  const info = await client.getRepoInfo();
  if (!info) {
    throw badRequest(
      `Can't open ${ref.owner}/${ref.repo}. Check the URL and that your GitHub token can read it.`,
    );
  }

  const branch = info.default_branch || "main";
  let head = await client.getRefSha(`heads/${branch}`);
  if (!head) {
    throw badRequest(
      `Repo ${ref.owner}/${ref.repo} has no ${branch} branch yet. Push at least one commit first, or start from an idea instead.`,
    );
  }

  const commit = await client.getCommit(head);
  const tree = await client.getTree(commit.tree.sha, true);
  const paths = tree.tree.filter((entry) => entry.type === "blob").map((entry) => entry.path);
  if (paths.length === 0) {
    throw badRequest("This repo has no files to scope yet.");
  }

  const name = input.projectName?.trim() || ref.repo;
  const inferred = inferFeaturesFromPaths(paths, name);
  const plan: ImportedPlan = {
    projectName: name,
    features: inferred.map((feature) => ({
      slug: feature.slug,
      title: feature.title,
      description: feature.description,
      dependsOn: feature.dependsOn,
      scopeNotes: feature.scopeNotes,
      manifest: normalizeManifest(feature.manifest, feature.slug),
      testSpec: feature.testSpec,
    })),
    sharedFileWarnings: [],
    warnings: [],
  };

  const { project } = await importPlan(repo, {
    plan,
    userId: input.userId,
    testMode: input.testMode ?? "skip",
  });

  const tokenEnc = await encryptSecret(input.githubToken, requireEncryptionKey(env));
  await repo.updateProjectRepo(project.id, {
    repoUrl: `https://github.com/${ref.owner}/${ref.repo}`,
    repoOwner: ref.owner,
    repoName: ref.repo,
    defaultBranch: branch,
    githubTokenEnc: tokenEnc,
  });
  await repo.setVersionCommit(project.id, 0, head);
  await repo.setUserGithubToken(input.userId, tokenEnc);

  const treeListing = formatTreeForPrompt(paths);
  const refinePrompt = existingRepoScopingPrompt({
    projectName: name,
    repoUrl: `https://github.com/${ref.owner}/${ref.repo}`,
    treeListing,
  });

  return {
    project_id: project.id,
    name: project.name,
    feature_count: plan.features.length,
    features: plan.features.map((f) => ({ id: f.slug, title: f.title, scope_notes: f.scopeNotes })),
    refine_prompt: refinePrompt,
    path_count: paths.length,
  };
}
