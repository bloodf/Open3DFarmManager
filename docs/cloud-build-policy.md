# Cloud build policy

Product development remains on HOLD. These controls do not authorize deployment,
publication, changes to live settings, or bypassing reviews and branch protection.

## GitHub Actions

`Checks` and `Simulator` run only through `workflow_dispatch`. Their jobs, security
restrictions, permissions, concurrency cancellation, and timeouts remain intact.
Pushes and pull requests no longer start their dependency installs, development
tests, builds, browser tests, Docker builds, or simulators automatically after this
policy reaches the relevant branch. Older branches retain their old triggers until
updated. Existing queued or running jobs require separate live containment.

Local lint, affected unit tests, security regression coverage, and objective review
of the exact proposed revision remain required. Use the repository's existing local
validation commands and `scripts/local-ci.sh` when full verification is authorized.
Do not report skipped tests as passing. The existing `check:all` publication rule
still applies unless the owner explicitly limits a tooling task's validation.

Manual workflows must exist on the default branch before GitHub can dispatch them.
Required status checks may still block merging. A local check does not satisfy a
required GitHub status. Keep branch protection, security scanning, required reviews,
and unresolved checks intact. The coordinator must resolve any required workflow
conflict before publication; do not fabricate a success or use an admin bypass.

## Vercel

The repository contains one application, `apps/farm`. It has a Nuxt build and a
`node-server` Nitro preset. This task does not change its runtime or build command.
No existing Vercel configuration or local `.vercel/project.json` identifies a linked
project. A project name, ID, team, live root directory, and complete set of connected
projects cannot be proven from this checkout.

Both the repository root and `apps/farm` have `vercel.json` controls, covering either
root choice for the known application. `git.deploymentEnabled` disables `**` and
enables `main`. Vercel documents that an explicit true rule wins when multiple
rules match. This blocks automatic Git deployments for feature and PR branches.
Do not use the deprecated `github.enabled` setting.

The dependency-free ignored build script requires production, `main`, no PR ID,
and a changed input between `VERCEL_GIT_PREVIOUS_SHA` and the checked-out
`VERCEL_GIT_COMMIT_SHA`. Vercel defines the previous SHA as the last successful
deployment for that project and branch. Comparing those trees covers squash,
merge, and multi-commit integration. NUL-separated names and disabled rename
detection preserve deletions and moves into or out of site inputs.

The gate conservatively treats all paths as inputs except `docs/`, `tests/`,
`.github/`, `.codegraph/`, `README.md`, `AGENTS.md`, `.codegraph-version`,
`renovate.json`, and the gate's own test script. Application files, workspace
dependencies, scripts, root configuration, runtime pins, lockfiles, and shipped
license notices therefore trigger a build. Unknown paths trigger a build rather
than silently omitting a new dependency. This can rebuild for unrelated tool or
simulator changes; narrow those inputs only with evidence about the live build.

Exit 1 means build. Exit 0 cancels without claiming validation success. A `HOLD`
message cancels when metadata is absent or invalid, checkout SHA differs, history
is unavailable, or the previous commit is not an ancestor. No `HEAD^` fallback or
network fetch guesses the deployed baseline. First deployment, a force push, or a
shallow clone missing the prior commit needs an explicitly authorized history or
deployment decision. This favors cost containment and can delay a required update.
The shell guard also cancels if the script is absent.

The ignored step still occupies deployment quota and a concurrent build slot.
The Git branch control prevents those requests earlier. Neither file disables
manual deploys, CLI/API deployments, deploy hooks, or deployment from an old
revision. Merging to `main` alone does not prove required reviews or integration
checks passed; protected-branch policy must enforce those requirements.

## Live settings owned by the coordinator

Before pushing this policy, verify containment against every Vercel project linked
to this repository, including projects absent from local link files. Record each
project ID, team, root directory, configuration-file override, production branch,
and Git integration. Confirm the selected configuration is loaded, production
branch is `main`, system Git environment variables are available, and the app-root
project can read the repository-level gate and shared dependencies. Review any
dashboard ignore command, automatic unaffected-project skipping, deploy hooks,
and older branches. Inspect GitHub Actions state and required checks without
weakening protection. This task makes no live changes and does not establish
live containment.

## Focused local check

```sh
node --test scripts/test-vercel-ignore.mjs
```

This creates isolated temporary Git fixtures and removes them afterward. It does
not install dependencies, build the application, run hosted jobs, or deploy.

## Official references

- https://vercel.com/docs/project-configuration/git-configuration
- https://vercel.com/docs/project-configuration/vercel-json
- https://vercel.com/docs/project-configuration/project-settings#ignored-build-step
- https://vercel.com/docs/environment-variables/system-environment-variables
- https://vercel.com/docs/builds/configure-a-build
- https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow
- https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches

These references were read during the tooling task. Live settings still require
independent verification by the coordinator.
