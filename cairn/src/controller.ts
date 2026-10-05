import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { ApplyEngine, type ApplyResult, type Session } from './apply';
import { forkPoint, Git, humanizeBranch, lastFetchTime, rebaseState, type GitDirs, type RebaseState } from './git';
import { PrCache } from './github';
import { listCatalogStacks, parseCatalog, snapshotStackFile, stackFilePath, type CatalogStack } from './metadata';
import { computePlan, describePlan, PlanError, type Plan } from './plan';
import type {
	BuilderVM,
	CandidateVM,
	CommitInfo,
	FileStat,
	LayerVM,
	OpVM,
	PlanVM,
	StackSummaryVM,
	StackVM,
	ToHost,
	ToWebview,
	ViewState,
	WrongLayerVM,
} from './protocol';
import type { Run, RunResult } from './run';
import { branchesWithoutPr, describeExit, EXIT, ordinal, readStackView, stackProblems, type StackView, type ViewOutcome } from './stack';

export interface Logger {
	line(text: string): void;
	show(): void;
}

type RefreshKind = 'local' | 'full' | 'network';
const RANK: Record<RefreshKind, number> = { local: 0, full: 1, network: 2 };

interface Draft {
	title?: string;
	body?: string;
}

interface Candidate extends CandidateVM {
	base: string;
}

interface Repo {
	git: Git;
	dirs: GitDirs;
	engine: ApplyEngine;
}

interface StackContext {
	view: StackView;
	vm: StackVM;
	trunkTip: string;
	candidates: Candidate[];
}

export class StackController implements vscode.WebviewViewProvider, vscode.Disposable {
	static readonly viewId = 'cairn.stack';

	private view?: vscode.WebviewView;
	private repo?: Repo;
	private repoSearched = false;
	private tools?: 'ok' | 'missing-gh' | 'missing-gh-stack';
	private outcome?: ViewOutcome;
	private state: ViewState = { status: 'loading' };
	private stack?: StackContext;
	private busy: string | null = null;
	private timer?: NodeJS.Timeout;
	private syncTimer?: NodeJS.Timeout;
	private lastSync = 0;
	private pendingKind: RefreshKind | null = null;
	private refreshing: Promise<void> | null = null;
	private conflictFiles = new Set<string>();
	private builderTrunk: string | null = null;
	/** the Create a stack form shown on top of an open stack */
	private builderOpen = false;
	private layerCache = new Map<string, { commits: CommitInfo[]; files: FileStat[]; body: string }>();
	private readonly disposables: vscode.Disposable[] = [];
	private readonly watchers: vscode.Disposable[] = [];
	readonly prs: PrCache;

	constructor(
		private readonly ctx: vscode.ExtensionContext,
		private readonly run: Run,
		private readonly log: Logger,
		private readonly statusBar: vscode.StatusBarItem,
	) {
		this.prs = new PrCache(run, () => this.gh);
		this.disposables.push(
			vscode.workspace.onDidChangeWorkspaceFolders(() => this.resetRepo()),
			vscode.workspace.onDidSaveTextDocument(() => this.schedule('local')),
			vscode.window.onDidChangeWindowState(s => s.focused && (this.syncDue() ? void this.sync() : this.schedule('local'))),
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration('cairn')) {
					this.tools = undefined;
					this.startSyncTimer();
					this.schedule('full');
				}
			}),
		);
		this.startSyncTimer();
	}

	dispose(): void {
		clearInterval(this.syncTimer);
		this.watchers.forEach(d => d.dispose());
		this.disposables.forEach(d => d.dispose());
	}

	get gh(): string {
		return vscode.workspace.getConfiguration('cairn').get<string>('ghPath')?.trim() || 'gh';
	}

	get remote(): string {
		return vscode.workspace.getConfiguration('cairn').get<string>('remote')?.trim() || 'origin';
	}

	// -------------------------------------------------------------------------
	// Webview

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, 'dist'), vscode.Uri.joinPath(this.ctx.extensionUri, 'media')],
		};
		view.webview.html = this.html(view.webview);
		view.webview.onDidReceiveMessage((m: ToHost) => this.onMessage(m).catch(e => this.fail(e)), undefined, this.disposables);
		view.onDidChangeVisibility(() => {
			if (view.visible) {
				this.post({ type: 'state', state: this.state });
				if (this.syncDue()) {
					void this.sync();
				}
			}
		}, undefined, this.disposables);
	}

	private html(webview: vscode.Webview): string {
		const nonce = randomBytes(16).toString('base64');
		const script = webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'webview.js'));
		const style = webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'cairn.css'));
		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>Cairn</title>
</head>
<body>
<div id="root"><div class="empty"><p class="loading"><span class="dot pending"></span>Loading stack…</p></div></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
	}

	private post(msg: ToWebview): void {
		void this.view?.webview.postMessage(msg);
	}

	private setState(state: ViewState): void {
		this.state = state;
		this.post({ type: 'state', state });
		this.updateStatusBar();
	}

	private async onMessage(m: ToHost): Promise<void> {
		switch (m.type) {
			case 'ready': this.post({ type: 'state', state: this.state }); return this.schedule('network', 0);
			case 'refresh': this.tools = undefined; return this.schedule('full', 0);
			case 'fetch': return this.fetch();
			case 'checkout': return this.checkout(m.branch);
			case 'openPr': await vscode.env.openExternal(vscode.Uri.parse(m.url)); return;
			case 'openFile': return this.openFile(m.branch, m.path);
			case 'setDraft': return this.setDraft(m.branch, m.title, m.body);
			case 'submit': return this.submit(m.open);
			case 'previewPlan': return this.previewPlan(m.order);
			case 'applyPlan': return this.applyPlan(m.order);
			case 'undo': return this.undo();
			case 'dismissApplied': return this.dismissApplied();
			case 'publish': return this.publish();
			case 'continueRebase': return this.continueRebase();
			case 'abortRebase': return this.abortRebase();
			case 'resolveFile': return this.resolveFile(m.path);
			case 'moveEdits': return this.moveEdits(m.target);
			case 'switchStack': return this.switchStack(m.top);
			case 'builderTrunk': this.builderTrunk = m.trunk; return this.schedule('local', 0);
			case 'openBuilder': return this.openBuilder();
			case 'closeBuilder': this.builderOpen = false; return this.schedule('local', 0);
			case 'initStack': return this.initStack(m.trunk, m.branches);
			case 'openWorktree': return this.openWorktree(m.branch);
			case 'installGhStack': return this.installGhStack();
			case 'showOutput': this.log.show(); return;
			case 'openSettings': await vscode.commands.executeCommand('workbench.action.openSettings', 'cairn'); return;
		}
	}

	// -------------------------------------------------------------------------
	// Refresh

	schedule(kind: RefreshKind, delay = 200): void {
		if (this.pendingKind === null || RANK[kind] > RANK[this.pendingKind]) {
			this.pendingKind = kind;
		}
		clearTimeout(this.timer);
		this.timer = setTimeout(() => void this.flush(), delay);
	}

	private async flush(): Promise<void> {
		if (this.refreshing) {
			await this.refreshing;
		}
		if (this.busy) {
			return;
		}
		const kind = this.pendingKind;
		this.pendingKind = null;
		if (!kind) {
			return;
		}
		this.refreshing = this.refresh(kind).catch(e => this.fail(e)).finally(() => (this.refreshing = null));
		await this.refreshing;
		if (this.pendingKind) {
			await this.flush();
		}
	}

	private resetRepo(): void {
		this.repo = undefined;
		this.repoSearched = false;
		this.outcome = undefined;
		this.stack = undefined;
		this.prs.clear();
		this.watchers.forEach(d => d.dispose());
		this.watchers.length = 0;
		this.schedule('network', 0);
	}

	private async ensureRepo(): Promise<Repo | undefined> {
		if (this.repo || this.repoSearched) {
			return this.repo;
		}
		this.repoSearched = true;
		const folders = (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file');
		const active = vscode.window.activeTextEditor?.document.uri;
		const activeFolder = active ? vscode.workspace.getWorkspaceFolder(active) : undefined;
		const ordered = activeFolder ? [activeFolder, ...folders.filter(f => f !== activeFolder)] : folders;
		for (const f of ordered) {
			try {
				const dirs = await new Git(this.run, f.uri.fsPath).dirs();
				const git = new Git(this.run, dirs.topLevel);
				const key = `cairn.apply:${dirs.commonDir}`;
				const engine = new ApplyEngine(this.run, dirs, {
					get: () => this.ctx.workspaceState.get<Session>(key),
					set: v => Promise.resolve(this.ctx.workspaceState.update(key, v)),
				});
				this.repo = { git, dirs, engine };
				this.watch(dirs);
				return this.repo;
			} catch {
				// not a git repository; try the next folder
			}
		}
		return undefined;
	}

	private watch(dirs: GitDirs): void {
		const on = (base: string, glob: string, kind: RefreshKind) => {
			const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(base), glob));
			const fire = () => this.schedule(kind);
			w.onDidChange(fire);
			w.onDidCreate(fire);
			w.onDidDelete(fire);
			this.watchers.push(w);
		};
		on(dirs.gitDir, 'HEAD', 'full');
		on(dirs.gitDir, 'index', 'local');
		on(dirs.commonDir, 'refs/heads/**', 'full');
		on(dirs.commonDir, 'packed-refs', 'full');
		on(dirs.commonDir, 'gh-stack', 'full');
		on(dirs.commonDir, 'refs/remotes/**', 'local');
	}

	private async checkTools(cwd: string): Promise<'ok' | 'missing-gh' | 'missing-gh-stack'> {
		if (this.tools) {
			return this.tools;
		}
		try {
			const r = await this.run(this.gh, ['--version'], { cwd, quiet: true });
			if (r.code !== 0) {
				return 'missing-gh';
			}
		} catch {
			return 'missing-gh';
		}
		const r = await this.run(this.gh, ['stack', '--version'], { cwd, quiet: true });
		this.tools = r.code === 0 ? 'ok' : 'missing-gh-stack';
		return this.tools;
	}

	private async refresh(kind: RefreshKind): Promise<void> {
		const repo = await this.ensureRepo();
		if (!repo) {
			return this.setState({ status: 'no-repo' });
		}
		const tools = await this.checkTools(repo.dirs.topLevel);
		if (tools === 'missing-gh') {
			return this.setState({ status: 'missing-gh', ghPath: this.gh });
		}
		if (tools === 'missing-gh-stack') {
			return this.setState({ status: 'missing-gh-stack' });
		}
		const rs = await rebaseState(repo.dirs);
		// A paused rebase leaves HEAD detached; keep the last good view instead of asking gh stack mid-rebase.
		if (!this.outcome || (kind !== 'local' && rs.kind === 'none')) {
			this.outcome = await readStackView(this.run, this.gh, repo.dirs.topLevel);
		}
		await this.build(repo, rs);

		const open = this.openPrNumbers();
		if (kind === 'network') {
			await this.prs.refresh(repo.dirs.topLevel, open, { force: true });
			await this.build(repo, await rebaseState(repo.dirs));
		} else {
			const before = JSON.stringify(open.map(n => this.prs.get(n)?.title));
			await this.prs.refresh(repo.dirs.topLevel, open, { force: false });
			if (JSON.stringify(open.map(n => this.prs.get(n)?.title)) !== before) {
				await this.build(repo, await rebaseState(repo.dirs));
			}
		}
	}

	private openPrNumbers(): number[] {
		if (this.outcome?.kind !== 'ok') {
			return [];
		}
		return this.outcome.view.branches.filter(b => b.pr && b.pr.state !== 'MERGED').map(b => b.pr!.number);
	}

	private async build(repo: Repo, rs: RebaseState): Promise<void> {
		const outcome = this.outcome!;
		const common = {
			repoName: path.basename(repo.dirs.topLevel),
			lastFetch: this.ctx.workspaceState.get<number>(`cairn.lastFetch:${repo.dirs.commonDir}`) ?? (await lastFetchTime(repo.dirs)),
			op: await this.opVM(repo, rs),
		};
		const catalog = await this.catalogStacks(repo);

		if (outcome.kind === 'error') {
			this.stack = undefined;
			return this.setState({ status: 'error', code: outcome.code, stderr: outcome.stderr, command: `${this.gh} stack view --json` });
		}
		if (outcome.kind === 'not-in-stack' || outcome.kind === 'ambiguous') {
			this.stack = undefined;
			const currentBranch = (await repo.git.currentBranch()) ?? 'HEAD';
			return this.setState({
				status: 'no-stack',
				currentBranch,
				ambiguous: outcome.kind === 'ambiguous',
				stacks: this.summaries(catalog, currentBranch, null),
				builder: await this.builderVM(repo, catalog),
				...common,
			});
		}
		const ctx = await this.buildStack(repo, outcome.view, catalog, rs);
		this.stack = ctx;
		this.setState({
			status: 'ready',
			stack: ctx.vm,
			builder: this.builderOpen ? await this.builderVM(repo, catalog) : null,
			...common,
		});
	}

	private async catalogStacks(repo: Repo): Promise<CatalogStack[]> {
		try {
			const snap = await snapshotStackFile(repo.dirs.commonDir);
			if (!snap.bytes) {
				return [];
			}
			const raw = JSON.parse(snap.bytes.toString());
			return Array.isArray(raw?.stacks) ? listCatalogStacks(raw) : [];
		} catch {
			return [];
		}
	}

	private summaries(catalog: CatalogStack[], currentBranch: string, view: StackView | null): StackSummaryVM[] {
		const viewOrder = view?.branches.map(b => b.name).join('\n');
		return catalog.filter(s => s.branches.length > 0).map(s => {
			const top = s.branches[s.branches.length - 1].branch;
			return {
				key: String(s.index),
				label: s.number ? `Stack #${s.number} · ${top}` : top,
				top,
				trunk: s.trunk,
				size: s.branches.length,
				active: view ? s.branches.map(b => b.branch).join('\n') === viewOrder : s.branches.some(b => b.branch === currentBranch),
			};
		});
	}

	private async layerContents(git: Git, base: string, head: string, wantBody: boolean) {
		const key = `${base}..${head}`;
		let hit = this.layerCache.get(key);
		if (!hit) {
			const [commits, files] = await Promise.all([git.log(base, head).catch(() => []), git.numstat(base, head).catch(() => [])]);
			hit = { commits, files, body: '' };
			if (wantBody && commits.length === 1) {
				hit.body = (await git.commitMessage(commits[0].sha).catch(() => ({ body: '' }))).body;
			}
			if (this.layerCache.size > 500) {
				this.layerCache.clear();
			}
			this.layerCache.set(key, hit);
		}
		return hit;
	}

	private async buildStack(repo: Repo, view: StackView, catalog: CatalogStack[], rs: RebaseState): Promise<StackContext> {
		const { git } = repo;
		const [refs, status] = await Promise.all([git.branchRefs(), git.status()]);
		const trunkRef = refs.has(view.trunk) ? `refs/heads/${view.trunk}` : `${this.remote}/${view.trunk}`;
		const drafts = this.drafts(repo);

		const layers: LayerVM[] = [];
		for (let i = 0; i < view.branches.length; i++) {
			const b = view.branches[i];
			const head = b.head ?? refs.get(b.name)?.sha ?? '';
			let parent = view.trunk;
			for (let j = i - 1; j >= 0; j--) {
				if (b.isMerged || !view.branches[j].isMerged) {
					parent = view.branches[j].name;
					break;
				}
			}
			const parentRef = parent === view.trunk ? trunkRef : `refs/heads/${parent}`;
			let rangeBase = b.base ?? '';
			let rangeSource: LayerVM['rangeSource'] = 'recorded';
			if (head && !(b.base && (await git.isAncestor(b.base, head)))) {
				rangeBase = (await git.mergeBase(parentRef, head)) ?? b.base ?? head;
				rangeSource = 'merge-base';
			}
			const contents = head ? await this.layerContents(git, rangeBase, head, !b.pr) : { commits: [], files: [], body: '' };
			const details = b.pr ? this.prs.get(b.pr.number) : undefined;
			const d = drafts[b.name] ?? {};
			const defaultTitle = details?.title ?? (contents.commits.length === 1 ? contents.commits[0].subject : humanizeBranch(b.name));
			const defaultBody = details?.body ?? contents.body;
			layers.push({
				name: b.name,
				head,
				base: b.base ?? '',
				rangeBase,
				rangeSource,
				parent,
				isCurrent: b.name === view.currentBranch,
				isMerged: b.isMerged,
				isQueued: b.isQueued,
				needsRebase: b.needsRebase,
				pr: b.pr && {
					number: b.pr.number,
					url: b.pr.url ?? details?.url,
					state: b.pr.state,
					title: details?.title,
					body: details?.body,
					isDraft: details?.isDraft,
					reviewDecision: details?.reviewDecision ?? null,
					ci: details?.ci ?? 'none',
					comments: details ? details.comments : null,
					baseRefName: details?.baseRefName,
					detailed: !!details,
				},
				track: refs.get(b.name)?.track ?? { ahead: 0, behind: 0, gone: false },
				commits: contents.commits,
				files: contents.files,
				additions: contents.files.reduce((n, f) => n + (f.additions ?? 0), 0),
				deletions: contents.files.reduce((n, f) => n + (f.deletions ?? 0), 0),
				draft: {
					title: d.title ?? defaultTitle,
					body: d.body ?? defaultBody,
					titleEdited: d.title !== undefined && d.title !== defaultTitle,
					bodyEdited: d.body !== undefined && d.body !== defaultBody,
				},
			});
		}

		const candidates = await this.candidates(repo, view, catalog, layers, refs);
		const vm: StackVM = {
			trunk: { name: view.trunk, track: refs.get(view.trunk)?.track ?? { ahead: 0, behind: 0, gone: false } },
			currentBranch: view.currentBranch,
			layers,
			stacks: this.summaries(catalog, view.currentBranch, view),
			candidates: candidates.map(({ name, head, commits }) => ({ name, head, commits })),
			dirty: { tracked: status.tracked, untracked: status.untracked },
			wrongLayer: this.wrongLayer(layers, view.currentBranch, [...status.tracked, ...status.untracked]),
			rebaseInProgress: rs.kind !== 'none',
			hasMerged: layers.some(l => l.isMerged),
			remote: this.remote,
			defaultTrunk: (await git.defaultTrunk()) ?? view.trunk,
		};
		const bottom = layers.find(l => !l.isMerged) ?? layers[0];
		const trunkTip = bottom?.rangeBase || (await git.revParse(trunkRef)) || '';
		return { view, vm, trunkTip, candidates };
	}

	private async candidates(repo: Repo, view: StackView, catalog: CatalogStack[], layers: LayerVM[], refs: Map<string, { sha: string }>): Promise<Candidate[]> {
		const tracked = new Set(catalog.flatMap(s => s.branches.map(b => b.branch)));
		view.branches.forEach(b => tracked.add(b.name));
		let names: string[];
		try {
			names = await repo.git.localBranchesNotMergedInto(view.trunk);
		} catch {
			return [];
		}
		const out: Candidate[] = [];
		const layerHeads = layers.filter(l => !l.isMerged && l.head).map(l => l.head);
		for (const name of names.filter(n => !tracked.has(n) && n !== view.trunk).slice(0, 40)) {
			const head = refs.get(name)?.sha;
			if (!head) {
				continue;
			}
			const base = await forkPoint(repo.git, view.trunk, layerHeads, head);
			if (!base) {
				continue;
			}
			const count = await repo.git.raw(['rev-list', '--count', `${base}..${head}`]);
			out.push({ name, head, base, commits: Number(count.stdout.trim()) || 0 });
		}
		return out;
	}

	/** Dirty files that only a lower layer touches suggest the edits belong there. */
	private wrongLayer(layers: LayerVM[], current: string, dirty: string[]): WrongLayerVM | null {
		const idx = layers.findIndex(l => l.name === current);
		if (idx <= 0 || dirty.length === 0) {
			return null;
		}
		const mine = new Set(layers[idx].files.map(f => f.path));
		const loose = dirty.filter(p => !mine.has(p));
		let best: { layer: LayerVM; files: string[] } | null = null;
		for (let i = idx - 1; i >= 0; i--) {
			const l = layers[i];
			if (l.isMerged) {
				continue;
			}
			const theirs = new Set(l.files.map(f => f.path));
			const files = loose.filter(p => theirs.has(p));
			if (files.length > 0 && (!best || files.length > best.files.length)) {
				best = { layer: l, files };
			}
		}
		return best ? { target: best.layer.name, current, files: best.files } : null;
	}

	private async builderVM(repo: Repo, catalog: CatalogStack[]): Promise<BuilderVM> {
		const { git } = repo;
		const refs = await git.branchRefs();
		const trunks = [...refs.keys()];
		const def = (await git.defaultTrunk()) ?? trunks[0] ?? 'main';
		const trunk = this.builderTrunk && refs.has(this.builderTrunk) ? this.builderTrunk : def;
		const tracked = new Set(catalog.flatMap(s => s.branches.map(b => b.branch)));
		let names: string[] = [];
		try {
			names = (await git.localBranchesNotMergedInto(trunk)).filter(n => !tracked.has(n));
		} catch {
			// trunk does not exist locally
		}
		const candidates: CandidateVM[] = [];
		for (const name of names.slice(0, 60)) {
			const r = await git.raw(['rev-list', '--count', `${trunk}..${name}`]);
			candidates.push({ name, head: refs.get(name)?.sha ?? '', commits: Number(r.stdout.trim()) || 0 });
		}
		const status = await git.status();
		const rs = await rebaseState(repo.dirs);
		const dirtyReason = rs.kind !== 'none'
			? 'A rebase is in progress. Finish or abort it first.'
			: status.tracked.length
				? `You have uncommitted changes in ${status.tracked.length} file${status.tracked.length === 1 ? '' : 's'}. gh stack init checks out the top branch after writing the stack file, so a dirty tree leaves a half-created stack. Commit or stash first.`
				: undefined;
		return {
			trunks: [trunk, ...trunks.filter(t => t !== trunk)],
			trunk,
			candidates,
			clean: !dirtyReason,
			dirtyReason,
		};
	}

	private async opVM(repo: Repo, rs: RebaseState): Promise<OpVM> {
		if (this.busy) {
			return { kind: 'running', label: this.busy };
		}
		const s = repo.engine.session;
		if (s?.phase === 'running' && rs.kind === 'none') {
			return { kind: 'conflict', source: 'cairn', files: [], allStaged: false, interrupted: true, step: s.next + 1, total: s.steps.length, branch: s.steps[s.next]?.branch };
		}
		if (s?.phase === 'conflict' || rs.kind !== 'none') {
			const unmerged = await repo.git.unmergedFiles().catch(() => [] as string[]);
			unmerged.forEach(f => this.conflictFiles.add(f));
			const source = s?.phase === 'conflict' ? 'cairn' : rs.kind === 'gh-stack' ? 'gh-stack' : 'git';
			return {
				kind: 'conflict',
				source,
				branch: s?.steps[s.next]?.branch,
				step: s ? s.next + 1 : undefined,
				total: s?.steps.length,
				files: [...this.conflictFiles].map(p => ({ path: p, staged: !unmerged.includes(p) })),
				allStaged: unmerged.length === 0,
			};
		}
		this.conflictFiles.clear();
		if (s?.phase === 'applied') {
			const blocker = await repo.engine.undoBlocker();
			return { kind: 'applied', canUndo: !blocker, undoBlockedReason: blocker ?? undefined, published: s.published };
		}
		return { kind: 'idle' };
	}

	private updateStatusBar(): void {
		const s = this.state;
		if (s.status !== 'ready') {
			this.statusBar.hide();
			return;
		}
		const layers = s.stack.layers;
		const idx = layers.findIndex(l => l.isCurrent);
		if (idx >= 0) {
			this.statusBar.text = `$(layers) ${layers[idx].name} ${idx + 1}/${layers.length}`;
			this.statusBar.tooltip = `Cairn: you are on ${layers[idx].name}, ${ordinal(idx + 1)} of ${layers.length} layers. Click to check out another layer.`;
		} else {
			this.statusBar.text = `$(layers) ${s.stack.trunk.name} · ${layers.length} layers`;
			this.statusBar.tooltip = `Cairn: you are on the trunk of a ${layers.length}-layer stack. Click to check out a layer.`;
		}
		this.statusBar.show();
	}

	// -------------------------------------------------------------------------
	// Running commands

	private async exec(cmd: string, args: string[], opts: { env?: Record<string, string>; input?: string } = {}): Promise<RunResult> {
		const repo = await this.ensureRepo();
		return this.run(cmd, args, { cwd: repo!.dirs.topLevel, ...opts });
	}

	private async withBusy<T>(label: string, fn: () => Promise<T>): Promise<T> {
		this.busy = label;
		if (this.state.status === 'ready' || this.state.status === 'no-stack') {
			this.setState({ ...this.state, op: { kind: 'running', label } });
		}
		try {
			return await fn();
		} finally {
			this.busy = null;
		}
	}

	/** Shows the exit code meaning and stderr, and points at the output channel. */
	private async reportFailure(what: string, r: RunResult, gh = true): Promise<void> {
		const meaning = gh ? describeExit(r.code) : `exit code ${r.code}`;
		const detail = r.stderr.trim().split('\n').slice(-6).join('\n');
		const pick = await vscode.window.showErrorMessage(`${what} failed (${r.code}: ${meaning}).`, { detail, modal: false }, 'Show Output');
		if (pick === 'Show Output') {
			this.log.show();
		}
	}

	private fail(e: unknown): void {
		const msg = e instanceof Error ? e.message : String(e);
		this.log.line(`error: ${msg}`);
		void vscode.window.showErrorMessage(`Cairn: ${msg}`, 'Show Output').then(p => p && this.log.show());
	}

	private async confirm(message: string, detail: string, action: string): Promise<boolean> {
		const pick = await vscode.window.showWarningMessage(message, { modal: true, detail }, action);
		return pick === action;
	}

	/** Why a checkout-class command (checkout, init, add, rebase, sync) must not run now, or null. */
	private async gitGuard(what: string): Promise<string | null> {
		const repo = await this.ensureRepo();
		if (!repo) {
			return 'No git repository is open.';
		}
		if (this.busy) {
			return `${this.busy} is still running.`;
		}
		if (repo.engine.inFlight) {
			return 'A reorder is paused. Continue or abort it first.';
		}
		const rs = await rebaseState(repo.dirs);
		if (rs.kind !== 'none') {
			return rs.kind === 'gh-stack' && rs.journal !== 'gh-stack-rebase-state'
				? `gh stack has an unfinished operation (${rs.journal}). Recover it in a terminal before running ${what}.`
				: 'A rebase is in progress. Continue or abort it first.';
		}
		const st = await repo.git.status();
		if (st.tracked.length > 0) {
			return `You have uncommitted changes in ${st.tracked.length} file${st.tracked.length === 1 ? '' : 's'}. Commit or stash them before ${what}.`;
		}
		return null;
	}

	private async refuse(reason: string): Promise<void> {
		await vscode.window.showWarningMessage(reason);
	}

	// -------------------------------------------------------------------------
	// Navigation

	async checkout(branch: string): Promise<void> {
		const reason = await this.gitGuard(`checking out ${branch}`);
		if (reason) {
			return this.refuse(reason);
		}
		const isTrunk = this.stack?.view.trunk === branch;
		const args = isTrunk ? ['stack', 'trunk'] : ['stack', 'checkout', branch];
		const r = await this.withBusy(`Checking out ${branch}`, () => this.exec(this.gh, args));
		if (r.code !== 0) {
			await this.reportFailure(`gh ${args.join(' ')}`, r);
		}
		this.schedule('full', 0);
	}

	async navigate(dir: 'up' | 'down' | 'top' | 'bottom'): Promise<void> {
		const reason = await this.gitGuard(`gh stack ${dir}`);
		if (reason) {
			return this.refuse(reason);
		}
		const r = await this.withBusy(`gh stack ${dir}`, () => this.exec(this.gh, ['stack', dir]));
		if (r.code !== 0) {
			await this.reportFailure(`gh stack ${dir}`, r);
		}
		this.schedule('full', 0);
	}

	async pickCheckout(): Promise<void> {
		if (!this.stack) {
			await this.refresh('full');
		}
		const s = this.stack;
		if (!s) {
			return this.refuse('This branch is not part of a stack.');
		}
		const items = [...s.vm.layers].reverse().map(l => ({
			label: `${l.isCurrent ? '$(circle-filled)' : l.isMerged ? '$(check)' : '$(circle-outline)'} ${l.pr?.title ?? l.draft.title}`,
			description: `${l.pr ? `#${l.pr.number} · ` : ''}${l.name}`,
			branch: l.name,
		}));
		items.push({ label: `$(git-branch) ${s.view.trunk}`, description: 'trunk', branch: s.view.trunk });
		const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Check out a layer', matchOnDescription: true });
		if (pick) {
			await this.checkout(pick.branch);
		}
	}

	private async switchStack(top: string): Promise<void> {
		const reason = await this.gitGuard('switching stacks');
		if (reason) {
			return this.refuse(reason);
		}
		const r = await this.withBusy(`Switching to ${top}`, () => this.exec(this.gh, ['stack', 'checkout', top]));
		if (r.code !== 0) {
			await this.reportFailure(`gh stack checkout ${top}`, r);
		}
		this.schedule('network', 0);
	}

	async fetch(): Promise<void> {
		const repo = await this.ensureRepo();
		if (!repo) {
			return;
		}
		const r = await this.withBusy('Fetching', () => this.exec('git', ['fetch', '--prune']));
		if (r.code !== 0) {
			await this.reportFailure('git fetch --prune', r, false);
		} else {
			await this.fetched(repo);
		}
		this.schedule('network', 0);
	}

	private async fetched(repo: Repo): Promise<void> {
		this.lastSync = Date.now();
		await this.ctx.workspaceState.update(`cairn.lastFetch:${repo.dirs.commonDir}`, this.lastSync);
	}

	private syncIntervalMs(): number {
		return Math.max(0, vscode.workspace.getConfiguration('cairn').get<number>('syncInterval') ?? 60) * 1000;
	}

	private startSyncTimer(): void {
		clearInterval(this.syncTimer);
		const ms = this.syncIntervalMs();
		this.syncTimer = ms ? setInterval(() => void this.sync(), Math.max(ms, 15_000)) : undefined;
	}

	private syncDue(): boolean {
		const ms = this.syncIntervalMs();
		return ms > 0 && Date.now() - this.lastSync >= ms;
	}

	/** Background fetch plus PR re-read. Quiet: no banner, and a failed fetch is only logged. */
	private async sync(): Promise<void> {
		const ready = this.state.status === 'ready' || this.state.status === 'no-stack';
		if (!ready || this.busy || !this.view?.visible || !vscode.window.state.focused || !this.repo) {
			return;
		}
		const repo = this.repo;
		if ((await rebaseState(repo.dirs)).kind !== 'none') {
			return;
		}
		this.lastSync = Date.now();
		const r = await this.run('git', ['fetch', '--prune', '--quiet', this.remote], { cwd: repo.dirs.topLevel, env: { GIT_TERMINAL_PROMPT: '0' }, quiet: true });
		if (r.code === 0) {
			await this.fetched(repo);
		}
		this.schedule('network', 0);
	}

	private async openFile(branch: string, file: string): Promise<void> {
		const repo = await this.ensureRepo();
		const layer = this.stack?.vm.layers.find(l => l.name === branch);
		if (!repo || !layer) {
			return;
		}
		const uri = vscode.Uri.file(path.join(repo.dirs.topLevel, file));
		if (layer.isCurrent) {
			await vscode.commands.executeCommand('vscode.open', uri);
			return;
		}
		const gitApi = vscode.extensions.getExtension<{ getAPI(v: 1): { toGitUri(u: vscode.Uri, ref: string): vscode.Uri } }>('vscode.git')?.exports?.getAPI(1);
		if (!gitApi) {
			await vscode.commands.executeCommand('vscode.open', uri);
			return;
		}
		await vscode.commands.executeCommand(
			'vscode.diff',
			gitApi.toGitUri(uri, layer.rangeBase),
			gitApi.toGitUri(uri, layer.head),
			`${file} (${branch})`,
		);
	}

	// -------------------------------------------------------------------------
	// Titles, bodies, submit

	private drafts(repo: Repo): Record<string, Draft> {
		return this.ctx.workspaceState.get<Record<string, Draft>>(`cairn.drafts:${repo.dirs.commonDir}`) ?? {};
	}

	private async saveDrafts(repo: Repo, drafts: Record<string, Draft>): Promise<void> {
		await this.ctx.workspaceState.update(`cairn.drafts:${repo.dirs.commonDir}`, drafts);
	}

	private async setDraft(branch: string, title?: string | null, body?: string | null): Promise<void> {
		const repo = await this.ensureRepo();
		if (!repo) {
			return;
		}
		const drafts = this.drafts(repo);
		const d = { ...drafts[branch] };
		if (title !== undefined) {
			if (title === null) {
				delete d.title;
			} else {
				d.title = title;
			}
		}
		if (body !== undefined) {
			if (body === null) {
				delete d.body;
			} else {
				d.body = body;
			}
		}
		drafts[branch] = d;
		await this.saveDrafts(repo, drafts);
		this.schedule('local', 400);
	}

	async submit(open: boolean): Promise<void> {
		const repo = await this.ensureRepo();
		const s = this.stack;
		if (!repo || !s) {
			return this.refuse('There is no stack to submit.');
		}
		if (this.busy || repo.engine.inFlight || (await rebaseState(repo.dirs)).kind !== 'none') {
			return this.refuse('Finish the running operation or rebase before submitting.');
		}
		const submitArgs = ['stack', 'submit', '--auto', '--remote', this.remote, ...(open ? ['--open'] : [])];
		const edits = s.vm.layers.filter(l => !l.isMerged && (l.draft.titleEdited || l.draft.bodyEdited));
		const trunkPush = await this.trunkPush(repo, s.view.trunk);
		const detail = [
			...(trunkPush ? [`git ${trunkPush.join(' ')}   (${s.view.trunk} is not on ${this.remote} yet)`] : []),
			`${this.gh} ${submitArgs.join(' ')}`,
			...edits.map(l => `${this.gh} pr edit ${l.pr ? `#${l.pr.number}` : `<new PR for ${l.name}>`}${l.draft.titleEdited ? ' --title …' : ''} --body …`),
			'',
			open ? 'New and existing PRs will be marked ready for review.' : 'New PRs are created as drafts.',
		].join('\n');
		if (!(await this.confirm(open ? 'Submit the stack and mark every PR ready for review?' : 'Submit the stack?', detail, open ? 'Submit and mark ready' : 'Submit'))) {
			return;
		}
		await this.withBusy('Submitting', async () => {
			if (trunkPush && !(await this.pushTrunk(trunkPush))) {
				return;
			}
			await repo.engine.markPublished();
			if (!(await this.runSubmit(repo, submitArgs))) {
				return;
			}
			await this.applyEdits(repo, edits.map(l => l.name));
		});
		this.schedule('network', 0);
	}

	/** gh stack never pushes the trunk, and GitHub cannot open a PR into a base it does not have. */
	private async trunkPush(repo: Repo, trunk: string): Promise<string[] | null> {
		return (await repo.git.remoteHasBranch(this.remote, trunk)) === false ? ['push', '-u', this.remote, trunk] : null;
	}

	private async pushTrunk(args: string[]): Promise<boolean> {
		const r = await this.exec('git', args);
		if (r.code !== 0) {
			await this.reportFailure(`git ${args.join(' ')}`, r, false);
			return false;
		}
		return true;
	}

	/**
	 * Runs gh stack submit. gh-stack exits 0 when PR creation fails, so a missing PR is
	 * reported here. Returns false only when the command itself failed.
	 */
	private async runSubmit(repo: Repo, args: string[]): Promise<boolean> {
		const r = await this.exec(this.gh, args);
		if (r.code !== 0) {
			await this.reportFailure('gh stack submit', r);
			return false;
		}
		const outcome = await readStackView(this.run, this.gh, repo.dirs.topLevel);
		const missing = outcome.kind === 'ok' ? branchesWithoutPr(outcome.view) : [];
		if (missing.length > 0) {
			const detail = stackProblems(r.stderr).slice(-6).join('\n') || r.stderr.trim().split('\n').slice(-6).join('\n');
			const pick = await vscode.window.showErrorMessage(
				`gh stack submit pushed the branches but created no PR for ${missing.join(', ')}.`,
				{ detail, modal: false },
				'Show Output',
			);
			if (pick === 'Show Output') {
				this.log.show();
			}
		}
		return true;
	}

	/** After submit: one `gh pr edit` for each card whose title or body differs from GitHub. */
	private async applyEdits(repo: Repo, branches: string[]): Promise<void> {
		if (branches.length === 0) {
			return;
		}
		this.outcome = await readStackView(this.run, this.gh, repo.dirs.topLevel);
		if (this.outcome.kind !== 'ok') {
			return;
		}
		const view = this.outcome.view;
		const numbers = view.branches.filter(b => b.pr).map(b => b.pr!.number);
		await this.prs.refresh(repo.dirs.topLevel, numbers, { force: true });
		await this.build(repo, await rebaseState(repo.dirs));
		const drafts = this.drafts(repo);
		for (const name of branches) {
			const l = this.stack?.vm.layers.find(x => x.name === name);
			const actual = l?.pr ? this.prs.get(l.pr.number) : undefined;
			if (!l?.pr || !actual) {
				this.log.line(`skipped gh pr edit for ${name}: no PR found after submit`);
				continue;
			}
			const d = drafts[name] ?? {};
			const title = d.title ?? actual.title;
			const body = d.body ?? actual.body;
			if (title === actual.title && body === actual.body) {
				delete drafts[name];
				continue;
			}
			const r = await this.exec(this.gh, ['pr', 'edit', String(l.pr.number), '--title', title, '--body', body]);
			if (r.code !== 0) {
				await this.reportFailure(`gh pr edit ${l.pr.number}`, r, false);
				continue;
			}
			delete drafts[name];
		}
		await this.saveDrafts(repo, drafts);
	}

	// -------------------------------------------------------------------------
	// Reorder

	private computePlanFor(order: string[]): Plan {
		const s = this.stack;
		if (!s) {
			throw new PlanError('no stack is loaded');
		}
		return computePlan({
			trunk: { name: s.view.trunk, tip: s.trunkTip },
			current: s.vm.layers.map(l => ({ name: l.name, head: l.head, base: l.rangeBase, isMerged: l.isMerged })),
			candidates: s.candidates.map(c => ({ name: c.name, head: c.head, base: c.base })),
			proposed: order,
		});
	}

	private async planBlockers(plan: Plan): Promise<{ blockers: string[]; warnings: string[] }> {
		const repo = this.repo!;
		const s = this.stack!;
		const blockers: string[] = [];
		const warnings: string[] = [];
		if (this.busy) {
			blockers.push(`${this.busy} is still running.`);
		}
		if (repo.engine.inFlight) {
			blockers.push('A reorder is already paused. Continue or abort it first.');
		}
		const rs = await rebaseState(repo.dirs);
		if (rs.kind !== 'none') {
			blockers.push('A rebase is already in progress.');
		}
		const st = await repo.git.status();
		if (st.tracked.length > 0) {
			blockers.push(`The worktree has uncommitted changes in ${st.tracked.length} file${st.tracked.length === 1 ? '' : 's'}. Commit or stash first.`);
		}
		if (s.vm.hasMerged) {
			blockers.push('The stack has merged branches. Run gh stack sync first.');
		}
		const refs = await repo.git.branchRefs();
		for (const name of new Set([...s.vm.layers.map(l => l.name), ...plan.added])) {
			const t = refs.get(name)?.track;
			if (t && t.behind > 0) {
				blockers.push(`${name} is ${t.behind} commit${t.behind === 1 ? '' : 's'} behind ${t.upstream}. Pull it first: a later push would drop those remote commits.`);
			}
		}
		try {
			const snap = await snapshotStackFile(repo.dirs.commonDir);
			if (snap.bytes) {
				parseCatalog(snap.bytes);
			}
		} catch (e) {
			blockers.push((e as Error).message);
		}
		const last = this.state.status === 'ready' ? this.state.lastFetch : null;
		const tracksRemote = [s.vm.trunk.track, ...s.vm.layers.map(l => l.track)].some(t => t.upstream);
		if (tracksRemote && (!last || Date.now() - last > 15 * 60_000)) {
			warnings.push(`Remote-tracking refs were ${last ? `last fetched ${Math.round((Date.now() - last) / 60_000)} minutes ago` : 'never fetched'}. Fetch first so the behind-upstream check is current.`);
		}
		if (plan.removed.length) {
			warnings.push(`${plan.removed.join(', ')} will stop being tracked. The branch${plan.removed.length === 1 ? '' : 'es'} and any PR stay as they are.`);
		}
		return { blockers, warnings };
	}

	private async previewPlan(order: string[]): Promise<void> {
		try {
			const plan = this.computePlanFor(order);
			const { blockers, warnings } = await this.planBlockers(plan);
			const vm: PlanVM = {
				steps: describePlan(plan, stackFilePath(this.repo!.dirs.commonDir)),
				moved: plan.moved,
				added: plan.added,
				removed: plan.removed,
				noop: plan.noop,
				blockers,
				warnings,
			};
			this.post({ type: 'plan', order, plan: vm });
		} catch (e) {
			this.post({ type: 'plan', order, plan: null, error: (e as Error).message });
		}
	}

	private async applyPlan(order: string[]): Promise<void> {
		const repo = this.repo;
		const s = this.stack;
		if (!repo || !s) {
			return;
		}
		let plan: Plan;
		try {
			plan = this.computePlanFor(order);
		} catch (e) {
			return this.refuse((e as Error).message);
		}
		const { blockers } = await this.planBlockers(plan);
		if (blockers.length) {
			return this.refuse(blockers.join(' '));
		}
		const lines = describePlan(plan, stackFilePath(repo.dirs.commonDir)).map((l, i) => `${i + 1}. ${l.command}`);
		const ok = await this.confirm(
			'Apply this reorder locally?',
			`${lines.join('\n')}\n\nEvery branch SHA and the gh-stack file are snapshotted first, so Undo can restore them. Nothing is pushed.`,
			'Apply',
		);
		if (!ok) {
			return;
		}
		this.conflictFiles.clear();
		const result = await this.withBusy('Applying reorder', () =>
			repo.engine.start(plan, {
				trunk: s.view.trunk,
				trunkTip: s.trunkTip,
				originalOrder: s.view.branches.map(b => b.name),
				branches: s.vm.layers.map(l => l.name),
			}),
		).catch(e => ({ kind: 'failed', message: (e as Error).message, restored: false }) as ApplyResult);
		await this.afterApply(result);
	}

	private async afterApply(result: ApplyResult): Promise<void> {
		if (result.kind === 'applied') {
			void vscode.window.showInformationMessage('Reorder applied locally. Nothing was pushed.', 'Publish…', 'Undo').then(p => {
				if (p === 'Publish…') {
					void this.publish();
				} else if (p === 'Undo') {
					void this.undo();
				}
			});
		} else if (result.kind === 'conflict') {
			result.files.forEach(f => this.conflictFiles.add(f));
			void vscode.window.showWarningMessage(`Rebase paused on ${result.branch} (step ${result.step} of ${result.total}): ${result.files.length} conflicted file${result.files.length === 1 ? '' : 's'}. Resolve them in the Cairn panel.`);
		} else {
			this.fail(new Error(`${result.message}${result.restored ? ' Every branch and the gh-stack file were restored.' : ''}`));
		}
		this.outcome = undefined;
		this.schedule('full', 0);
	}

	async continueRebase(): Promise<void> {
		const repo = await this.ensureRepo();
		if (!repo) {
			return;
		}
		if (repo.engine.session?.phase === 'conflict') {
			const result = await this.withBusy('Continuing rebase', () => repo.engine.continue());
			if (result.kind === 'failed' && !result.restored) {
				return this.refuse(result.message);
			}
			return this.afterApply(result);
		}
		const rs = await rebaseState(repo.dirs);
		const unmerged = await repo.git.unmergedFiles();
		if (unmerged.length) {
			return this.refuse(`Stage these files first: ${unmerged.join(', ')}`);
		}
		const [cmd, args] = rs.kind === 'gh-stack' ? [this.gh, ['stack', 'rebase', '--continue']] : ['git', ['rebase', '--continue']];
		const r = await this.withBusy('Continuing rebase', () => this.exec(cmd, args, { env: { GIT_EDITOR: 'true' } }));
		if (r.code !== 0 && r.code !== EXIT.conflict) {
			await this.reportFailure(`${cmd === 'git' ? 'git' : 'gh'} ${args.join(' ')}`, r, cmd !== 'git');
		}
		this.outcome = undefined;
		this.schedule('full', 0);
	}

	async abortRebase(): Promise<void> {
		const repo = await this.ensureRepo();
		if (!repo) {
			return;
		}
		if (repo.engine.session && repo.engine.session.phase !== 'applied') {
			if (!(await this.confirm('Abort the reorder?', 'Every branch goes back to its snapshot SHA and the gh-stack file to its original bytes.', 'Abort and restore'))) {
				return;
			}
			await this.withBusy('Restoring snapshot', () => repo.engine.abort()).catch(e => this.fail(e));
		} else {
			const rs = await rebaseState(repo.dirs);
			const [cmd, args] = rs.kind === 'gh-stack' ? [this.gh, ['stack', 'rebase', '--abort']] : ['git', ['rebase', '--abort']];
			if (!(await this.confirm('Abort the rebase?', `Runs ${cmd === 'git' ? 'git' : 'gh'} ${args.join(' ')}.`, 'Abort'))) {
				return;
			}
			const r = await this.withBusy('Aborting rebase', () => this.exec(cmd, args));
			if (r.code !== 0) {
				await this.reportFailure(`${args.join(' ')}`, r, cmd !== 'git');
			}
		}
		this.conflictFiles.clear();
		this.outcome = undefined;
		this.schedule('full', 0);
	}

	private async resolveFile(file: string): Promise<void> {
		const repo = await this.ensureRepo();
		if (!repo) {
			return;
		}
		const uri = vscode.Uri.file(path.join(repo.dirs.topLevel, file));
		try {
			await vscode.commands.executeCommand('git.openMergeEditor', uri);
		} catch {
			await vscode.commands.executeCommand('vscode.open', uri);
		}
	}

	async undo(): Promise<void> {
		const repo = await this.ensureRepo();
		if (!repo) {
			return;
		}
		const blocker = await repo.engine.undoBlocker();
		if (blocker) {
			return this.refuse(`Cannot undo: ${blocker}.`);
		}
		if (!(await this.confirm('Undo the reorder?', 'Every branch goes back to the SHA it had before Apply, and the gh-stack file to its original bytes.', 'Undo'))) {
			return;
		}
		await this.withBusy('Undoing reorder', () => repo.engine.undo()).catch(e => this.fail(e));
		this.outcome = undefined;
		this.schedule('full', 0);
	}

	async publish(): Promise<void> {
		const repo = await this.ensureRepo();
		const s = this.stack;
		if (!repo || !s) {
			return;
		}
		if (this.busy || repo.engine.inFlight || (await rebaseState(repo.dirs)).kind !== 'none') {
			return this.refuse('Finish the running operation or rebase before publishing.');
		}
		const push = ['stack', 'push', '--remote', this.remote];
		const submit = ['stack', 'submit', '--auto', '--remote', this.remote];
		const edits = s.vm.layers.filter(l => !l.isMerged && (l.draft.titleEdited || l.draft.bodyEdited));
		const trunkPush = await this.trunkPush(repo, s.view.trunk);
		const steps = [
			...(trunkPush ? [`git ${trunkPush.join(' ')}   (${s.view.trunk} is not on ${this.remote} yet)`] : []),
			`${this.gh} ${push.join(' ')}`,
			`${this.gh} ${submit.join(' ')}`,
			...edits.map(l => `${this.gh} pr edit ${l.pr ? `#${l.pr.number}` : `<new PR for ${l.name}>`} …`),
		];
		const ok = await this.confirm(
			'Publish the stack?',
			[
				...steps.map((step, i) => `${i + 1}. ${step}`),
				'',
				'Push runs first, so a rejected lease stops before any PR base is retargeted. Undo is no longer available afterwards.',
			].join('\n'),
			'Publish',
		);
		if (!ok) {
			return;
		}
		await this.withBusy('Publishing', async () => {
			if (trunkPush && !(await this.pushTrunk(trunkPush))) {
				return;
			}
			await repo.engine.markPublished();
			const p = await this.exec(this.gh, push);
			if (p.code !== 0) {
				return this.reportFailure('gh stack push', p);
			}
			if (!(await this.runSubmit(repo, submit))) {
				return;
			}
			await this.applyEdits(repo, edits.map(l => l.name));
		});
		this.schedule('network', 0);
	}

	async dismissApplied(): Promise<void> {
		await this.repo?.engine.dismiss();
		this.schedule('local', 0);
	}

	// -------------------------------------------------------------------------
	// Wrong-layer edits

	private async moveEdits(target: string): Promise<void> {
		const repo = await this.ensureRepo();
		if (!repo) {
			return;
		}
		if (this.busy || repo.engine.inFlight || (await rebaseState(repo.dirs)).kind !== 'none') {
			return this.refuse('Finish the running operation or rebase first.');
		}
		const from = await repo.git.currentBranch();
		const message = `cairn: move edits from ${from} to ${target}`;
		const ok = await this.confirm(
			`Move your uncommitted edits to ${target}?`,
			`1. git stash push --include-untracked -m "${message}"\n2. ${this.gh} stack checkout ${target}\n3. git stash pop\n\nIf the pop conflicts, the stash is kept so nothing is lost.`,
			'Move edits',
		);
		if (!ok) {
			return;
		}
		await this.withBusy(`Moving edits to ${target}`, async () => {
			const stash = await this.exec('git', ['stash', 'push', '--include-untracked', '-m', message]);
			if (stash.code !== 0) {
				return this.reportFailure('git stash push', stash, false);
			}
			const co = await this.exec(this.gh, ['stack', 'checkout', target]);
			if (co.code !== 0) {
				await this.reportFailure(`gh stack checkout ${target}`, co);
				const back = await this.exec('git', ['stash', 'pop']);
				if (back.code !== 0) {
					await this.reportFailure('git stash pop (restoring your edits on the original branch)', back, false);
				}
				return;
			}
			const pop = await this.exec('git', ['stash', 'pop']);
			if (pop.code !== 0) {
				await this.reportFailure(`git stash pop on ${target} (the stash was kept)`, pop, false);
			}
		});
		this.schedule('full', 0);
	}

	// -------------------------------------------------------------------------
	// Stack creation

	async openBuilder(): Promise<void> {
		this.builderOpen = true;
		this.builderTrunk = null;
		await vscode.commands.executeCommand(`${StackController.viewId}.focus`);
		this.schedule('local', 0);
	}

	private async initStack(trunk: string, branches: string[]): Promise<void> {
		const repo = await this.ensureRepo();
		if (!repo || branches.length === 0) {
			return;
		}
		const reason = await this.gitGuard('gh stack init');
		if (reason) {
			return this.refuse(reason);
		}
		const current = await repo.git.currentBranch();
		const catalog = await this.catalogStacks(repo);
		if (current && current !== trunk && catalog.some(s => s.branches.some(b => b.branch === current))) {
			const pick = await vscode.window.showWarningMessage(
				`You are on ${current}, which is already in a stack. Check out ${trunk} so the new stack can start there?`,
				{ modal: true },
				`Check out ${trunk}`,
			);
			if (!pick) {
				return;
			}
			const r = await this.exec('git', ['checkout', trunk]);
			if (r.code !== 0) {
				return this.reportFailure(`git checkout ${trunk}`, r, false);
			}
		}
		const args = ['stack', 'init', ...branches, '--base', trunk];
		const ok = await this.confirm(
			`Create a ${branches.length}-layer stack on ${trunk}?`,
			`${this.gh} ${args.join(' ')}\n\nBottom to top: ${trunk} ← ${branches.join(' ← ')}. Existing branches are adopted; missing ones are created. gh stack checks out ${branches[branches.length - 1]} afterwards.`,
			'Create stack',
		);
		if (!ok) {
			return;
		}
		const r = await this.withBusy('Creating stack', () => this.exec(this.gh, args));
		if (r.code !== 0) {
			await this.reportFailure('gh stack init', r);
			this.schedule('full', 0);
			return;
		}
		this.builderOpen = false;
		this.outcome = undefined;
		this.schedule('network', 0);
	}

	async addBranch(): Promise<void> {
		const s = this.stack;
		if (!s) {
			return this.refuse('Open a stack first.');
		}
		const name = await vscode.window.showInputBox({ prompt: 'New branch name to add on top of the stack', validateInput: v => (/^\S+$/.test(v) ? null : 'Enter a branch name') });
		if (!name) {
			return;
		}
		const reason = await this.gitGuard('gh stack add');
		if (reason) {
			return this.refuse(reason);
		}
		const top = s.vm.layers[s.vm.layers.length - 1];
		await this.withBusy(`Adding ${name}`, async () => {
			if (top && s.view.currentBranch !== top.name) {
				const t = await this.exec(this.gh, ['stack', 'top']);
				if (t.code !== 0) {
					return this.reportFailure('gh stack top', t);
				}
			}
			const r = await this.exec(this.gh, ['stack', 'add', name]);
			if (r.code !== 0) {
				await this.reportFailure(`gh stack add ${name}`, r);
			}
		});
		this.outcome = undefined;
		this.schedule('full', 0);
	}

	// -------------------------------------------------------------------------
	// Worktrees and setup

	async openWorktree(branch?: string): Promise<void> {
		const repo = await this.ensureRepo();
		if (!repo) {
			return;
		}
		if (!branch) {
			const picks = this.stack?.vm.layers.filter(l => !l.isCurrent && !l.isMerged).map(l => l.name) ?? [];
			branch = await vscode.window.showQuickPick(picks, { placeHolder: 'Open which layer in a new worktree?' });
			if (!branch) {
				return;
			}
		}
		if ((await rebaseState(repo.dirs)).kind !== 'none' || repo.engine.inFlight) {
			return this.refuse('A rebase is in progress. Finish or abort it before adding a worktree.');
		}
		if ((await repo.git.currentBranch()) === branch) {
			return this.refuse(`${branch} is checked out here. Open a different layer in the new worktree.`);
		}
		const top = repo.dirs.topLevel;
		const suggested = path.join(path.dirname(top), `${path.basename(top)}.worktrees`, branch.replace(/[^\w.-]+/g, '-'));
		const target = await vscode.window.showInputBox({ prompt: `Folder for the ${branch} worktree`, value: suggested, ignoreFocusOut: true });
		if (!target) {
			return;
		}
		const r = await this.withBusy(`Adding worktree for ${branch}`, () => this.exec('git', ['worktree', 'add', target, branch!]));
		if (r.code !== 0) {
			return this.reportFailure(`git worktree add ${target} ${branch}`, r, false);
		}
		await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target), { forceNewWindow: true });
	}

	async installGhStack(): Promise<void> {
		const ok = await this.confirm('Install the gh stack extension?', `Runs: ${this.gh} extension install github/gh-stack`, 'Install');
		if (!ok) {
			return;
		}
		const cwd = this.repo?.dirs.topLevel ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
		const r = await this.run(this.gh, ['extension', 'install', 'github/gh-stack'], { cwd });
		if (r.code !== 0) {
			await this.reportFailure('gh extension install github/gh-stack', r, false);
		}
		this.tools = undefined;
		this.schedule('network', 0);
	}

	/** Commands that only wrap one gh stack call behind the usual guards. */
	async simple(kind: 'sync' | 'rebaseUpstack' | 'unstackLocal' | 'unstack' | 'merge'): Promise<void> {
		const s = this.stack;
		switch (kind) {
			case 'sync': {
				const reason = await this.gitGuard('gh stack sync');
				if (reason) {
					return this.refuse(reason);
				}
				const args = ['stack', 'sync', '--remote', this.remote];
				if (!(await this.confirm('Sync the stack?', `${this.gh} ${args.join(' ')}\n\nFetches, rebases onto the trunk, pushes, and refreshes PR state.`, 'Sync'))) {
					return;
				}
				const r = await this.withBusy('Syncing', () => this.exec(this.gh, args));
				if (r.code === EXIT.conflict) {
					void vscode.window.showWarningMessage('gh stack sync hit a conflict and restored every branch. Run "Cairn: Rebase Upstack" to redo the rebase and resolve it.');
				} else if (r.code !== 0) {
					await this.reportFailure('gh stack sync', r);
				} else if (/Sync aborted/i.test(r.stderr + r.stdout)) {
					void vscode.window.showWarningMessage('gh stack sync aborted: the local and GitHub stacks diverged. Nothing changed. See the output channel.', 'Show Output').then(p => p && this.log.show());
				}
				break;
			}
			case 'rebaseUpstack': {
				const reason = await this.gitGuard('gh stack rebase');
				if (reason) {
					return this.refuse(reason);
				}
				const args = ['stack', 'rebase', '--upstack', '--remote', this.remote];
				if (!(await this.confirm('Rebase every layer above this one?', `${this.gh} ${args.join(' ')}`, 'Rebase'))) {
					return;
				}
				const r = await this.withBusy('Rebasing upstack', () => this.exec(this.gh, args));
				if (r.code === EXIT.conflict) {
					void vscode.window.showWarningMessage('gh stack rebase paused on a conflict. Resolve it in the Cairn panel.');
				} else if (r.code !== 0) {
					await this.reportFailure('gh stack rebase --upstack', r);
				}
				break;
			}
			case 'unstackLocal': {
				if (!(await this.confirm('Stop tracking this stack locally?', `${this.gh} stack unstack --local\n\nBranches, PRs, and the stack on GitHub are kept.`, 'Unstack locally'))) {
					return;
				}
				const r = await this.withBusy('Unstacking', () => this.exec(this.gh, ['stack', 'unstack', '--local']));
				if (r.code !== 0) {
					await this.reportFailure('gh stack unstack --local', r);
				}
				break;
			}
			case 'unstack': {
				if (!(await this.confirm('Remove this stack on GitHub and locally?', `${this.gh} stack unstack\n\nThe PRs are detached from the stack on GitHub. Branches and PRs are not deleted.`, 'Continue'))) {
					return;
				}
				if (!(await this.confirm('Really detach the PRs on GitHub?', 'This is the second confirmation. Use "Unstack locally" to keep the GitHub stack.', 'Detach PRs on GitHub'))) {
					return;
				}
				const r = await this.withBusy('Unstacking', () => this.exec(this.gh, ['stack', 'unstack']));
				if (r.code !== 0) {
					await this.reportFailure('gh stack unstack', r);
				}
				break;
			}
			case 'merge': {
				if (!s) {
					return this.refuse('Open a stack first.');
				}
				const open = s.vm.layers.filter(l => l.pr && l.pr.state === 'OPEN');
				const target = await vscode.window.showQuickPick(
					[...open].reverse().map(l => ({ label: `#${l.pr!.number} ${l.pr!.title ?? l.name}`, description: `merges this PR and every unmerged PR below it`, n: l.pr!.number })),
					{ placeHolder: 'Merge up to which PR?' },
				);
				if (!target) {
					return;
				}
				const method = await vscode.window.showQuickPick(['--squash', '--merge', '--rebase'], { placeHolder: 'Merge method' });
				if (!method) {
					return;
				}
				const args = ['stack', 'merge', String(target.n), '--yes', method];
				if (!(await this.confirm(`Merge through #${target.n}?`, `${this.gh} ${args.join(' ')}\n\nAll-or-nothing: if any PR in the set cannot merge, none do.`, 'Merge'))) {
					return;
				}
				const r = await this.withBusy('Merging', () => this.exec(this.gh, args));
				if (r.code !== 0) {
					await this.reportFailure('gh stack merge', r);
				}
				break;
			}
		}
		this.outcome = undefined;
		this.schedule('network', 0);
	}
}
