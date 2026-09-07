# Agent instructions for node-red-mcp-hub

See [DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md) and
[BUILDING_A_MULTI_NODE_RED_MCP_HOME_ASSISTANT_APP.md](BUILDING_A_MULTI_NODE_RED_MCP_HOME_ASSISTANT_APP.md)
for architecture and scope. This file covers workflow conventions.

## Build & test

From `node_red_mcp_hub/gateway/`:

```powershell
npm run build   # tsc -p tsconfig.json
npm test        # tsc -p tsconfig.test.json && node --test test-dist/test/*.js
```

Always run both, and get a clean pass, before committing.

## Versioning (4 files move together)

Bump all of these to the same value, never just one:

1. `node_red_mcp_hub/gateway/package.json` + `package-lock.json` via
   `npm version X.Y.Z --no-git-tag-version --allow-same-version`
2. `node_red_mcp_hub/config.yaml`'s top-level `version:`
3. `node_red_mcp_hub/Dockerfile`'s `ARG BUILD_VERSION=X.Y.Z`
4. `node_red_mcp_hub/gateway/src/version.ts`'s `APP_VERSION` fallback string

CI's `gateway` job fails the build if these 4 ever disagree.

## Changelog

Update both `CHANGELOG.md` (root, dated: `## X.Y.Z - YYYY-MM-DD`) and
`node_red_mcp_hub/CHANGELOG.md` (undated: `## X.Y.Z`) with matching entries
for any user-visible fix or feature.

## Verify Node-RED behavior from source, not assumption

Node-RED's Admin API has inconsistent response shapes (some JSON, some
plain-text via `res.sendStatus`) and some routes skip validation entirely
(e.g. `/inject/:id` never checks node type). Before "fixing" a reported bug
in `node-red.ts`, fetch the real upstream source
(`https://raw.githubusercontent.com/node-red/node-red/master/packages/node_modules/@node-red/...`)
to confirm the actual contract instead of guessing.

## Git workflow — `main` is protected

`main` requires a pull request with a passing `gateway` status check (CI) to
merge; direct pushes are blocked for non-admins. The repo owner (admin) can
bypass this, but treat that as an exception for trivial/config-only changes,
not the default path.

Normal flow:

```powershell
git checkout -b fix/short-description
# ...edit, build, test...
git add -A; git commit -m "..."
git push -u origin fix/short-description
gh pr create --base main --title "..." --body "..."
gh pr checks   # wait for gateway to pass
gh pr merge --squash --delete-branch
```

Only the `gateway` job is a required check; `codeql` and `addon-images`
report on the PR but don't block merge — still worth checking them.

## Commit/push confirmation

Before running `git commit`/`git push` to land a change (even on a feature
branch destined for a PR), summarize the change and ask the user to confirm,
following the established pattern in this repo's history. Never `git push
--force` or rewrite published history without explicit approval.

## Dependabot

`.github/dependabot.yml` ignores major-version bumps for `zod`, `typescript`,
and `@types/node` — these have known breaking changes for this codebase
(zod v4 changes `z.record()`'s signature; typescript v7 + `@types/node` v26
break global Node type resolution). Treat any future major-bump PR for a
dependency as a likely breaking change requiring code migration, not a
routine merge — verify CI is actually green before merging, don't assume.
