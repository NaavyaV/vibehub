import { Repo } from "../db/repo.js";
import { decryptSecret } from "../lib/crypto.js";
import { badRequest } from "../lib/errors.js";
import { requireEncryptionKey } from "./github.js";
import type { AppEnv, UserRow } from "../types.js";

export async function requireUserGithubToken(
  env: AppEnv,
  repo: Repo,
  userId: string,
): Promise<{ token: string; user: UserRow }> {
  const user = await repo.getUser(userId);
  if (!user?.github_token_enc) {
    throw badRequest(
      "Connect GitHub repo access first (sign in with GitHub and complete repo authorization in VibeHub).",
    );
  }
  const token = await decryptSecret(user.github_token_enc, requireEncryptionKey(env));
  return { token, user };
}
