/**
 * The GitHub Actions workflow that acts as VibeHub's build gate.
 *
 * VibeHub fires a `repository_dispatch` at the staging ref, this workflow builds
 * it, and reports back to the callback URL with the one-time token it was given.
 * Until that callback arrives the push stays in `testing` and the default branch
 * does not move.
 *
 * The default gate is "does it build". A feature's `test_spec` is advisory: the
 * test step runs but never fails the gate.
 */
export const WORKFLOW_PATH = ".github/workflows/vibehub-build.yml";

export const WORKFLOW_YAML = `# Managed by VibeHub. Verifies a staged push and reports the result back.
name: VibeHub build gate

on:
  repository_dispatch:
    types: [vibehub_build]

permissions:
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Check out the staged commit
        uses: actions/checkout@v4
        with:
          ref: \${{ github.event.client_payload.commit_sha }}

      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Install
        id: install
        run: |
          set -o pipefail
          if [ -f package-lock.json ]; then
            npm ci 2>&1 | tee -a /tmp/vibehub-output.txt
          elif [ -f package.json ]; then
            npm install 2>&1 | tee -a /tmp/vibehub-output.txt
          else
            echo "No package.json; nothing to install." | tee -a /tmp/vibehub-output.txt
          fi

      - name: Build
        id: build
        run: |
          set -o pipefail
          if [ -f package.json ]; then
            npm run build --if-present 2>&1 | tee -a /tmp/vibehub-output.txt
          fi

      # Advisory only: a failing feature test never blocks the merge.
      - name: Test (non-blocking)
        if: \${{ github.event.client_payload.test_spec != '' }}
        continue-on-error: true
        run: |
          set -o pipefail
          echo "test_spec: \${{ github.event.client_payload.test_spec }}" | tee -a /tmp/vibehub-output.txt
          npm test --if-present 2>&1 | tee -a /tmp/vibehub-output.txt || true

      - name: Report the result to VibeHub
        if: always()
        env:
          CALLBACK_URL: \${{ github.event.client_payload.callback_url }}
          CALLBACK_TOKEN: \${{ github.event.client_payload.callback_token }}
          SUCCEEDED: \${{ steps.install.outcome == 'success' && steps.build.outcome == 'success' }}
        run: |
          tail -c 20000 /tmp/vibehub-output.txt > /tmp/vibehub-tail.txt || echo "" > /tmp/vibehub-tail.txt
          jq -n --argjson success "\$( [ "\$SUCCEEDED" = "true" ] && echo true || echo false )" \\
                --rawfile output /tmp/vibehub-tail.txt \\
                '{success: \$success, output: \$output}' > /tmp/vibehub-body.json
          curl --fail-with-body -sS -X POST "\$CALLBACK_URL" \\
            -H "Authorization: Bearer \$CALLBACK_TOKEN" \\
            -H "Content-Type: application/json" \\
            --data @/tmp/vibehub-body.json
`;
