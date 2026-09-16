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
2. Skip drafts: their driver is still working. A draft that says "contains #N" waits until #N is merged and its driver has rebased it. Also skip a ready PR whose latest `## Ready for review @` report is not for its current head (it was pushed after reporting), and ask for a report on a ready PR that has none.
3. Order by the ready reports: honour `Depends on` and `Merge order`; for PRs that list each other under `Overlaps`, merge first the one that leaves the smaller rebase. Then cheapest-conflict first: PRs that touch no shared file (`server/index.js`, `server/db.js`, the CI harness) and few files go before PRs that touch the monoliths.
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
   5. Watch main's push CI for the merge commit. Poll the run's status rather than trusting `gh run watch --exit-status`, which also exits non-zero when the GitHub API itself times out (an HTTP 504 while the run is still in progress), and that reads as a false red:
      ```
      sha=$(gh pr view <n> --json mergeCommit -q .mergeCommit.oid)
      gh run list --workflow CI --commit "$sha" --json databaseId -q '.[0].databaseId'
      gh run view <run id> --json status,conclusion -q '"\(.status) \(.conclusion)"'
      ```
      Repeat the last command until it prints `completed …`; only `completed success` is green. An API error is not a result: ask again. (If the list is still empty, the run hasn't registered yet; list again.) Before calling main red, confirm it job by job with `gh run view <run id> --json jobs`. If main is red, fix it at once with a revert PR (`git revert <sha>` on a `fix/revert-<n>` branch in its own worktree, PR, CI, review, merge). Never push a fix to main directly.
   6. Look at the remaining PRs again. Any that now conflict with or lag main, ask their driver to rebase (a PR comment, or a message to that session). Don't rebase it yourself unless you take the branch over (see Handover).
   7. **Tell the driver its PR merged**, and that its worktree is prunable. A merge is invisible from the agent's side: it posted a ready report and is waiting for a review that has already happened. Nothing else tells it. On 2026-09-16 Agent D sat idle two days on a PR that merged as `bf5095e`, still believing it was awaiting review, because this step did not exist. One message, naming the squash SHA, so it can verify by content rather than take your word for it.
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
- When you request changes, the PR's driver fixes them: it flips the PR back to draft while working and posts a new ready report when done. You don't push to that branch: one driver per branch.
- Your own PRs get the same comment format before you merge them.

## Handover

A branch whose creating session has ended has no driver, so a PR that needs a rebase or requested changes can never merge. A worktree subagent ends when it reports; a terminal session can be closed.

1. **Establish who the driver is by asking, not by inferring.** A worktree path does not name a session, and your memory of who was assigned what is not evidence — on 2026-09-16 the integrator woke the wrong session for #617 from memory, and the branch turned out to live in an anonymous `.claude/worktrees/agent-*` checkout belonging to a subagent that had ended. Message each live session (`ListAgents`) and ask outright whether the branch is theirs, telling them not to adopt it to be helpful. "I could not find the driver" is not the same as "there is no driver": reassign only once every live session has disclaimed it. Two sessions on one branch is how work was lost here before (#212).
2. First try to resume the original session (for a subagent, send it a message; it keeps its context).
3. If it has ended, take the branch over: yourself for a small fix, otherwise brief a new worktree agent on that branch.
4. Whoever takes over posts `Taking over this branch from <session>` on the PR before its first push, and is the only driver from then on. Its ready report says `Status: taken over`.

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
   [ "$run" = "$prev" ] && echo "no new deploy run appeared"
   gh run view "$run" --json status,conclusion -q '"\(.status) \(.conclusion)"'
   ```
   Repeat the last command until it prints `completed …`; only `completed success` is a green deploy. An API error is not a result: ask again. The run includes the smoke test (`scripts/smoke.mjs`); a red smoke fails the run. "No new deploy run appeared" is a failed deploy, not a green one.
4. Report: the deployed SHA, the smoke result, every `After deploy` item from the merged PRs' ready reports, and what changed since the last staging deploy (`git log --oneline <previous staging sha>..<deployed sha>`). The previous staging SHA is the `headSha` of the last successful staging run in `gh run list --workflow "Deploy to Railway" --json databaseId,headSha,conclusion`; confirm a run's environment from its Banner line in `gh run view <id> --log`.

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
- A background agent that backgrounds its own wait (a CI watch, a long test run, a monitor) ends its turn and is never woken, so its report arrives with the PR half-done. Every brief says: run every wait in the foreground (`gh pr checks <n> --watch` with a 10-minute timeout, re-run until nothing is pending), and never background a wait. If an agent stops early anyway, resume it with a message repeating that instruction.

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
