import { Link } from "react-router-dom";
import { CompactSetupBar } from "./CompactSetupBar";
import { CopyBlock, Stack } from "./ui";
import type { PushKit } from "./AgentPushPanel";

export function AddProjectPrompt({
  pushKit,
  hasRepoAccess,
  hasMcpToken,
  repoAuthUrl,
  watching = false,
  mode = "bootstrap",
}: {
  pushKit: PushKit | null;
  hasRepoAccess: boolean;
  hasMcpToken: boolean;
  repoAuthUrl?: string;
  /** True while polling for a new project after the user sent the prompt to their agent. */
  watching?: boolean;
  /** bootstrap = first push; feature = ship a completed feature on an existing project */
  mode?: "bootstrap" | "feature";
}) {
  const prompt =
    (mode === "feature" && pushKit?.feature_push_prompt) ||
    pushKit?.push_prompt ||
    pushKit?.agent_push_prompt ||
    (mode === "feature"
      ? "I'm done building my feature — push it to VibeHub. Pull the latest snapshot, merge any newer main changes, test, then push_feature."
      : "Push this project to VibeHub using push_to_vibehub. Return project_url when done.");

  return (
    <Stack gap="sm" className="add-project-prompt">
      <CompactSetupBar
        hasRepoAccess={hasRepoAccess}
        hasMcpToken={hasMcpToken}
        repoAuthUrl={repoAuthUrl}
      />

      <p className="add-project-copy">
        {mode === "feature"
          ? "When you're done building, copy this into your agent — it will pull the latest code, merge any updates from teammates, test, and push your feature."
          : "Copy this into your agent, then say it in your project folder."}
        {watching ? " We'll open your project board as soon as the push lands." : null}
      </p>

      <CopyBlock text={prompt} label="Copy prompt" />

      <p className="add-project-footer muted">
        VibeHub files stay local (add <code>.vibehub/</code> to your{" "}
        <code>.gitignore</code>).{" "}
        <Link to="/settings">MCP setup help →</Link>
        {watching ? (
          <>
            {" "}
            · <span className="setup-watching">Waiting for push…</span>
          </>
        ) : null}
      </p>
    </Stack>
  );
}
