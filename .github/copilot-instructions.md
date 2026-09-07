# Copilot instructions for node-red-mcp-hub

See [AGENTS.md](../AGENTS.md) for full workflow conventions (build/test
commands, versioning lockstep, changelog format, git/PR workflow, Node-RED
source-verification methodology). Key points repeated here for quick access:

- Build: `npm run build` and test: `npm test`, both from
  `node_red_mcp_hub/gateway/` — require a clean pass before committing.
- Version is duplicated in 4 files that must always match: `gateway/package.json`,
  `node_red_mcp_hub/config.yaml`, `node_red_mcp_hub/Dockerfile`, `gateway/src/version.ts`.
- `main` is branch-protected: PRs need a passing `gateway` CI check to merge.
  Use `gh pr create` / `gh pr merge --squash --delete-branch` rather than
  pushing directly to `main`.
- Before changing `node-red.ts` to fix a reported bug, verify the real
  Node-RED Admin API behavior from upstream source rather than assuming.
- Ask for explicit confirmation before `git commit`/`git push`.
