# Cairn

A stacked-PR panel for VS Code and Cursor. Cairn draws the chain of branches you
manage with the official [`gh stack`](https://github.com/github/gh-stack) extension,
lets you check out any layer, edit PR titles and descriptions, and reorder the stack,
and shows what each layer contains.

Cairn does not track stacks itself. It reads `gh stack view --json` and writes through
`gh stack` and plain `git`, so whatever `gh stack` does on the command line stays true here.

## Requirements

- The GitHub CLI, `gh`, signed in (`gh auth login`). Cairn cannot install it.
- The stack extension: `gh extension install github/gh-stack`. If it is missing,
  the panel offers to run that command for you.
- A repository where stacked PRs are enabled on GitHub (exit code 9 otherwise).

## Install

Node.js is required to build the extension. From a clone of this repository:

```sh
npm install
npm run package
npx @vscode/vsce package --allow-missing-repository
cursor --install-extension cairn-0.1.0.vsix
```

Reload the window afterward. For VS Code, use `code --install-extension cairn-0.1.0.vsix`. **Extensions: Install from VSIX…** installs the same file.

`npm run package` type-checks, lints, and writes `dist/`. The `vsce` command writes `cairn-0.1.0.vsix` from the `version` in `package.json`.

## Where to put the panel

The **Cairn** view opens in the bottom panel. It is designed to be used wide:

- **Bottom panel** (default): the full card, with CI, review, comments, and diff size on one line.
- **A wide side pane**: drag the Cairn tab into the secondary side bar
  (View → Appearance → Secondary Side Bar) and widen it.

When the pane is narrow, each card collapses to its branch name and a single status
dot. More detail comes back as the pane widens.

## Reading the stack

The tip is at the top and the trunk is at the bottom. A thin rail connects the layers:

| Node | Meaning |
| --- | --- |
| filled circle | the branch you are on (also outlined in the accent colour, with **You are here**) |
| hollow circle | an open PR |
| dashed circle | a local branch with no PR yet |
| dimmed check | merged |
| warning dot | needs a rebase onto its parent |

Each card shows the PR title (or the branch name), `#number · branch`, and on the right:
CI, review decision, comments, and `+added −deleted`.
Expanding a card lists its commits (`git log <base>..<head>`, using the base SHA that
`gh stack` recorded) and its files (`git diff --numstat`). Clicking a file opens it.
On other layers it opens a diff.

**Fetch** runs `git fetch --prune`. Its tooltip says how long ago you last fetched.
PR details (title, body, CI, reviews, comments, diff size) are read with `gh pr view`
on first load, on Fetch, and when you switch stacks. While the view is visible and the
window is focused, Cairn also syncs in the background every `cairn.syncInterval` seconds
(default 60): a quiet `git fetch --prune` on the remote, then a fresh read of every open PR.
Coming back to the window after the interval has passed syncs right away.

## Moving around

- Double-click a card, press Enter on it, or use its **Check out** button.
- The status bar item (`feat/api 2/3`) opens a picker. The commands
  **Cairn: Up / Down / Top / Bottom** map to `gh stack up/down/top/bottom`.
- The stack menu switches to another stack by checking out its top branch.
- **New stack** (the `+` in the view title, or the dashed row under the current
  stack) starts another stack, usually on `main`. Unstacked branches can be
  dropped there or started with **New stack** on the row. You do not have to
  leave the stack you are looking at first.
- Checkout is refused while the tree has uncommitted tracked changes, while a rebase
  is in progress, or while a reorder is being applied.

If your uncommitted edits touch only files that belong to another layer, Cairn says so
("These edits look like they belong on feat/auth, and you are on feat/ui") and offers
to stash, check out that layer, and pop the stash. It does this only after you confirm.

## Editing and submitting

**Edit stack** (or **Edit** on a card) opens the title and description fields. The title
is prefilled from the PR, or from the commit subject when the layer has one commit.
Edits are kept in the workspace until you submit.

**Submit** runs `gh stack submit --auto --remote origin`, then `gh pr edit <n> --title … --body …`
for each card you changed. **Submit and mark ready for review** adds `--open`.

## Reordering

Drag cards, or press Alt+↑/↓, to propose a new order. Drag a branch from **Not in this
stack** into the column to add it, or drag a card out to remove it. Nothing runs yet:
Cairn shows the exact plan, for example

```
git rebase --onto <trunk-sha> <recorded-base-of-api> feat/api
git rebase --onto feat/api <recorded-base-of-ui> feat/ui
git rebase --onto feat/ui <recorded-base-of-auth> feat/auth
write .git/gh-stack
```

and only runs it after you confirm **Apply**. Each step uses the base SHA recorded
by `gh stack` as the upstream, never the parent branch name. With a branch name, a
moved branch would carry its old parent's commits along with it.

Before applying, Cairn snapshots every branch SHA and the exact bytes of the
`gh-stack` file. **Undo** puts both back. Undo is local and goes away once you push or
submit. Apply is refused when the tree is dirty, a rebase is in progress, the stack has
merged layers, or a branch is behind its upstream (the branch is named).

If a step conflicts, the panel pauses and lists the unmerged files. **Resolve** opens
the merge editor. **Continue** stays disabled until every file is staged, then
continues the remaining steps. **Abort** restores the snapshot.

**Publish** is a separate confirmation. It runs `gh stack push --remote origin`,
then `gh stack submit --auto --remote origin`.

## Other commands

| Command | Runs |
| --- | --- |
| Cairn: Add Branch on Top… | `gh stack add <branch>` (from the top layer) |
| Cairn: Rebase Upstack | `gh stack rebase --upstack --remote origin` |
| Cairn: Sync Stack | `gh stack sync --remote origin` |
| Cairn: Merge Stack… | `gh stack merge <pr> --yes` with `--squash`, `--merge`, or `--rebase` |
| Cairn: Stop Tracking Stack Locally | `gh stack unstack --local` |
| Cairn: Unstack on GitHub and Locally… | `gh stack unstack` (asks twice) |
| Cairn: Open Layer in New Worktree… | `git worktree add`, then opens a new window |
| Cairn: Show Output | the log of every command |

If a branch is not in a stack, the panel offers a builder: pick a trunk, choose and order
local branches bottom-first, and it shows the `gh stack init <branches> --base <trunk>`
command it will run (on a clean tree only).

## Safety

- Cairn never force-pushes by hand. Publishing goes through `gh stack push`, which
  uses a per-branch lease and skips merged and queued branches.
- Cairn never deletes a branch or a PR.
- Rebase, checkout, init, and add are refused on a dirty tree, except for the
  stash → checkout → pop flow, which you confirm.
- Every command, its exit code, and its stderr are written to the **Cairn** output
  channel. A non-zero exit is always reported as a failure, with what the code means
  for `gh stack` (2 not in a stack, 3 conflict, 4 API failure, 6 several stacks,
  7 rebase in progress, 8 locked, 9 stacked PRs not enabled, …).

## Settings

| Setting | Default | |
| --- | --- | --- |
| `cairn.ghPath` | `gh` | Path to the `gh` binary (machine scope). |
| `cairn.remote` | `origin` | Remote passed to push, submit, sync, and rebase. |
| `cairn.syncInterval` | `60` | Seconds between background fetch + PR refresh. `0` turns it off. |

## Differences from a literal reading of the gh stack docs

- After a conflict in a Cairn reorder, **Continue** runs `git rebase --continue` and
  then the remaining planned steps. `gh stack rebase --continue` only works on a rebase
  that `gh stack rebase` started, so Cairn uses it only for those.
- The stack switcher lists stacks by reading the `gh-stack` file, without changing it.
  `gh stack view --json` only describes the current stack.
- `gh stack view` itself refreshes PR state from GitHub when it runs. Cairn runs it
  after branch changes (debounced), not on a timer.
- Checking out the trunk uses `gh stack trunk`.
- Untracked files do not block checkout. Uncommitted changes to tracked files do.

## Development

```sh
npm install
npm run compile     # type-check, lint, bundle
npm test            # vitest against temporary git repositories
npm run demo        # creates .demo/stack: main ← feat/auth ← feat/api ← feat/ui
```

Press F5 and choose **Run Extension (demo stack)** to open the demo repository in an
Extension Development Host.

Without an Extension Development Host, `npm run harness` builds a Node harness. It runs
the real controller against real `gh stack` with a stubbed `vscode` module:

```sh
npm run harness
node .harness/run.js "$PWD/.demo/stack" --checkout feat/api --order feat/api,feat/ui,feat/auth --apply --undo
```

`scripts/harness/preview.html` renders the webview in a browser with the VS Code Dark
Modern or Light Modern colours (`?theme=dark|light`). Serve the repository root and open it.
