# Integrator manual

Read this only if you are the integrator. The shared rules in `CLAUDE.md` apply to you too; this file adds what only the integrator does. Where an older memory note disagrees with this file (pushing to main, merging without a review comment, who deploys staging), this file wins.

## What you own

- Reviewing and merging every PR to main. Nobody else merges.
- Deploying staging after each merge batch.
- Handing the owner the production promote command. You never deploy production.
- Small fixes of your own, through a PR like everyone else.
- Keeping `CLAUDE.md`, this file and `docs/agent-partition.md` current.

You never push to main. Every change, including yours, lands with `gh pr merge`.

## The merge queue loop

1. List what is waiting:
   `gh pr list --state open --json number,title,headRefName,isDraft,headRefOid,files`
2. Skip drafts. A draft that says "contains #N" waits until #N is merged and its author has rebased it.
3. Order the rest cheapest-conflict first: PRs that touch no shared file (`server/index.js`, `server/db.js`, the CI harness) and few files go before PRs that touch the monoliths or overlap another open PR.
4. For each PR, in that order:
   1. Check CI at the current head: `gh pr checks <n>`. The `CI` summary check must be green. Never merge past a red or pending check, and never call a red E2E "flake" until the failing spec passes in isolation on the same commit.
   2. Check the head contains current main (docs-only PRs are exempt):
      ```
      git fetch origin && git fetch origin pull/<n>/head
      git merge-base --is-ancestor origin/main <full head sha> && echo up-to-date
      ```
      If it doesn't, list what main has that the head lacks:
      ```
      git diff --name-only $(git merge-base <full head sha> origin/main) origin/main
      ```
      If every path it prints ends in `.md`, the head counts as up to date: markdown can't break code, and a rebase would only cost another CI run. Otherwise ask the driver to rebase. CI and your review then run again on the new head. Why: two PRs each green against an older main can break main with no text conflict, e.g. one renames an export the other still imports.
   3. Review the diff (`gh pr diff <n>`) and post the review comment (format below).
   4. If approved, merge pinned to the SHA you reviewed:
      `gh pr merge <n> --squash --match-head-commit <full head sha>`
   5. Watch main's push CI for the merge commit:
      ```
      sha=$(gh pr view <n> --json mergeCommit -q .mergeCommit.oid)
      gh run list --workflow CI --commit "$sha" --json databaseId -q '.[0].databaseId'
      gh run watch <run id> --exit-status
      ```
      (If the list is still empty, the run hasn't registered yet; list again.) If main goes red, fix it at once with a revert PR (`git revert <sha>` on a `fix/revert-<n>` branch in its own worktree, PR, CI, review, merge). Never push a fix to main directly.
   6. Look at the remaining PRs again. Any that now conflict with or lag main, ask their driver to rebase (a PR comment, or a message to that session). Don't rebase it yourself unless you take the branch over (see Handover).
5. When the batch is merged and main's push CI is green, deploy staging (below).

## Review record

Every merge needs a review comment on the PR, posted by you, for the PR's current head SHA. Get the head with `gh pr view <n> --json headRefOid -q .headRefOid` and post with `gh pr comment <n> --body-file <file>`.

The first line is exactly one of:

```
## Integrator review: approved @ <short head sha>
## Integrator review: changes requested @ <short head sha>
```

Then the findings, one per line as `file:line — severity — scenario` (what breaks, for whom, when), or `No findings.`

Rules:

- Merge only when the latest `## Integrator review:` comment is an approval for the PR's current head SHA.
- Any push after an approval, a rebase included, invalidates it. Review the new head and post a new comment before merging.
- When you request changes, the PR's author (the session driving that branch) fixes them. You don't push to that branch: one driver per branch.
- Your own PRs get the same comment format before you merge them.

## Handover

A branch whose creating session has ended has no driver, so a PR that needs a rebase or requested changes can never merge. A worktree subagent ends when it reports; a terminal session can be closed.

1. First try to resume the original session (for a subagent, send it a message; it keeps its context).
2. If it has ended, take the branch over: yourself for a small fix, otherwise brief a new worktree agent on that branch.
3. Whoever takes over posts `Taking over this branch from <session>` on the PR before its first push, and is the only driver from then on.

## Staging deploy

After each merge batch, deploy staging yourself without asking:

1. Make sure no deploy is queued, waiting or running. The workflow's `cancel-in-progress` cancels all of them, including an owner's production deploy still waiting for a runner. Every line must print `[]`:
   ```
   for s in queued waiting pending requested in_progress; do
     gh run list --workflow "Deploy to Railway" --status "$s" --json databaseId,status
   done
   ```
2. Note the commit you are shipping: `git fetch origin && git rev-parse origin/main`.
3. Dispatch and watch. Record the latest run id before dispatching, because right after dispatch `gh run list` can still return the previous finished run:
   ```
   prev=$(gh run list --workflow "Deploy to Railway" --limit 1 --json databaseId -q '.[0].databaseId')
   gh workflow run "Deploy to Railway" -f environment=staging -f ref=main
   run=$prev
   for i in $(seq 60); do
     sleep 5
     run=$(gh run list --workflow "Deploy to Railway" --limit 1 --json databaseId -q '.[0].databaseId')
     [ -n "$run" ] && [ "$run" != "$prev" ] && break
   done
   if [ "$run" != "$prev" ]; then gh run watch "$run" --exit-status; else echo "no new deploy run appeared"; fi
   ```
   The run includes the smoke test (`scripts/smoke.mjs`); a red smoke fails the run. "No new deploy run appeared" is a failed deploy, not a green one.
4. Report: the deployed SHA, the smoke result, and what changed since the last staging deploy (`git log --oneline <previous staging sha>..<deployed sha>`). The previous staging SHA is the `headSha` of the last successful staging run in `gh run list --workflow "Deploy to Railway" --json databaseId,headSha,conclusion`; confirm a run's environment from its Banner line in `gh run view <id> --log`.

Only when GitHub Actions is down: deploy from a clean detached worktree of origin/main, then smoke it by hand.

```
git fetch origin
git worktree add --detach ../dugri-staging-deploy origin/main
cd ../dugri-staging-deploy
railway up --ci --service dugri --environment staging
SMOKE_BASE_URL=<staging url> node scripts/smoke.mjs
cd - && git worktree remove ../dugri-staging-deploy
```

`railway up` ships the directory it runs in, so never run it from a working checkout.

Deploys don't carry per-environment data on the volume (template artwork, calibration, settings). If a change needs that data on staging, say so in the report.

## Production handoff

Production is owner-only. When staging is green, give the owner the promote command pinned to the exact SHA that passed staging, never `main`:

```
gh workflow run "Deploy to Railway" -f environment=production -f ref=<full sha that passed staging>
```

## Small fixes and delegation

- Small fix (a few lines, one domain, obvious test): do it yourself on your own `fix/<short>` branch in your own worktree, open a PR, wait for CI, post the review comment, merge.
- Anything bigger goes to worktree agents. Split the work by file ownership in `docs/agent-partition.md` so no two parallel agents edit the same file; if two tasks need the same file, run them one after the other. Brief each agent with its domain letter, the task, and "open your PR and stop". If your session is in plan mode, exit it before spawning agents.

## Worktree pruning

Stale worktrees pile up. Prune periodically:

1. List candidates: `git worktree list --porcelain`.
2. A worktree may be removed only if both hold:
   - its branch's PR is merged (`gh pr list --state merged --head <branch>` returns it) and the worktree's HEAD equals that PR's `headRefOid`, so nothing unpushed is lost;
   - `git -C <path> status --porcelain` prints nothing.
3. Print the list of worktrees you are about to remove before removing any.
4. Remove each with `git worktree remove <path>` (never `--force`) and `git branch -D <branch>`. Then `git worktree prune`.

Never remove the root checkout, a worktree with uncommitted changes, or one whose PR is still open.

## Keeping the docs current

When a rule changes, update the one place it lives, through a docs PR:

- rules for every session: `CLAUDE.md`;
- integrator-only procedure: this file;
- file ownership: `docs/agent-partition.md`.

State each rule once. Link to it instead of repeating it.
