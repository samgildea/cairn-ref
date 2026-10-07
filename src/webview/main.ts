import type {
	BuilderVM,
	CandidateVM,
	LayerVM,
	OpVM,
	PlanVM,
	StackSummaryVM,
	StackVM,
	ToHost,
	ToWebview,
	ViewState,
} from '../protocol';
import { ordinal } from '../stack';

declare function acquireVsCodeApi(): {
	postMessage(m: ToHost): void;
	getState(): Persisted | undefined;
	setState(s: Persisted): void;
};

interface Persisted {
	expanded: string[];
	editMode: boolean;
	editing: string[];
}

const vscode = acquireVsCodeApi();
const post = (m: ToHost) => vscode.postMessage(m);
const root = document.getElementById('root')!;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

// ---------------------------------------------------------------------------
// UI state (the host owns stack state; this is only presentation)

const persisted = vscode.getState();
const ui = {
	state: { status: 'loading' } as ViewState,
	focused: null as string | null,
	expanded: new Set<string>(persisted?.expanded ?? []),
	editMode: persisted?.editMode ?? false,
	editing: new Set<string>(persisted?.editing ?? []),
	/** proposed order, bottom first; null means the current order */
	proposed: null as string[] | null,
	/** the current order the proposal was made against */
	proposedFrom: '',
	plan: null as { order: string[]; plan: PlanVM | null; error?: string } | null,
	drafts: new Map<string, { title?: string; body?: string }>(),
	drag: null as { key: string; from: 'stack' | 'tray' } | null,
	dropIndex: null as number | null,
	dropTray: false,
	dropNew: false,
	renderPending: false,
	dismissedWarning: null as string | null,
	/** created: typed names that do not exist yet; gh stack init creates them from the trunk */
	builder: { trunk: null as string | null, selected: [] as string[], created: [] as string[] },
};

function persist(): void {
	vscode.setState({ expanded: [...ui.expanded], editMode: ui.editMode, editing: [...ui.editing] });
}

// ---------------------------------------------------------------------------
// Helpers

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ESC[c]);

function ago(ms: number | null): string {
	if (!ms) {
		return 'never';
	}
	const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
	if (s < 60) {
		return 'just now';
	}
	const m = Math.round(s / 60);
	if (m < 60) {
		return `${m} minute${m === 1 ? '' : 's'} ago`;
	}
	const h = Math.round(m / 60);
	if (h < 48) {
		return `${h} hour${h === 1 ? '' : 's'} ago`;
	}
	const d = Math.round(h / 24);
	return `${d} days ago`;
}

const ICON = {
	check: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg>',
	x: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>',
	dot: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3"/></svg>',
	// review glyphs are ringed so they never read as the CI glyphs once labels collapse
	reviewApproved: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M5.5 8.2l1.8 1.8 3.4-4"/></svg>',
	reviewChanges: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M8 4.8v3.6M8 10.6v.6"/></svg>',
	reviewRequired: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" stroke-dasharray="2.4 1.8"/></svg>',
	comment: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/></svg>',
	grip: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="6" cy="4" r="1"/><circle cx="10" cy="4" r="1"/><circle cx="6" cy="8" r="1"/><circle cx="10" cy="8" r="1"/><circle cx="6" cy="12" r="1"/><circle cx="10" cy="12" r="1"/></svg>',
	chevron: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg>',
};

function stackOf(): StackVM | null {
	return ui.state.status === 'ready' ? ui.state.stack : null;
}

function currentOrder(s: StackVM): string[] {
	return s.layers.map(l => l.name);
}

function proposedOrder(s: StackVM): string[] {
	return ui.proposed ?? currentOrder(s);
}

function isProposalActive(s: StackVM): boolean {
	return ui.proposed !== null && ui.proposed.join('\n') !== currentOrder(s).join('\n');
}

function movedSet(s: StackVM): Set<string> {
	if (!isProposalActive(s)) {
		return new Set();
	}
	const cur = currentOrder(s);
	const prop = proposedOrder(s);
	const keptCur = cur.filter(n => prop.includes(n));
	const keptProp = prop.filter(n => cur.includes(n));
	const moved = new Set(keptProp.filter((n, i) => keptCur[i] !== n));
	prop.filter(n => !cur.includes(n)).forEach(n => moved.add(n));
	return moved;
}

/** A tray branch dragged into the stack is shown as a provisional card. */
function provisional(c: CandidateVM, parent: string): LayerVM {
	return {
		name: c.name,
		head: c.head,
		base: '',
		rangeBase: '',
		rangeSource: 'merge-base',
		parent,
		isCurrent: false,
		isMerged: false,
		isQueued: false,
		needsRebase: false,
		track: { ahead: 0, behind: 0, gone: false },
		commits: [],
		files: [],
		additions: 0,
		deletions: 0,
		draft: { title: c.name, body: '', titleEdited: false, bodyEdited: false },
	};
}

function displayLayers(s: StackVM): Array<LayerVM & { added?: boolean }> {
	const byName = new Map(s.layers.map(l => [l.name, l] as const));
	const cands = new Map(s.candidates.map(c => [c.name, c] as const));
	const order = proposedOrder(s);
	const bottomFirst = order.map((n, i) => byName.get(n) ?? { ...provisional(cands.get(n)!, order[i - 1] ?? s.trunk.name), added: true });
	// merged layers are not part of the proposal; keep them where gh stack has them
	const merged = s.layers.filter(l => l.isMerged && !order.includes(l.name));
	return [...merged, ...bottomFirst].reverse();
}

function trayItems(s: StackVM): Array<{ name: string; commits: number; removed: boolean }> {
	const order = proposedOrder(s);
	const removed = s.layers.filter(l => !l.isMerged && !order.includes(l.name)).map(l => ({ name: l.name, commits: l.commits.length, removed: true }));
	const cands = s.candidates.filter(c => !order.includes(c.name)).map(c => ({ name: c.name, commits: c.commits, removed: false }));
	return [...removed, ...cands];
}

// ---------------------------------------------------------------------------
// Rendering

function render(): void {
	if (ui.drag) {
		ui.renderPending = true;
		return;
	}
	ui.renderPending = false;
	const switcherOpen = !!root.querySelector('details.switcher[open]');
	const positions = capturePositions();
	const focus = captureFocus();
	root.innerHTML = view();
	if (switcherOpen) {
		root.querySelector('details.switcher')?.setAttribute('open', '');
	}
	restoreFocus(focus);
	animateFrom(positions);
}

function view(): string {
	const s = ui.state;
	switch (s.status) {
		case 'loading':
			return `<div class="empty"><p class="loading"><span class="dot pending"></span>${esc(s.message ?? 'Loading stack…')}</p></div>`;
		case 'no-repo':
			return `<div class="empty"><p>Open a folder that is a git repository to see its stack.</p></div>`;
		case 'missing-gh':
			return `<div class="empty"><p><strong>GitHub CLI not found.</strong> Cairn runs <code>${esc(s.ghPath)}</code> and could not start it.</p>
				<p class="muted">Install it from <a href="https://cli.github.com">cli.github.com</a>, or point <code>cairn.ghPath</code> at the binary.</p>
				<div class="row-actions"><button class="btn" data-action="openSettings">Open settings</button><button class="btn secondary" data-action="refresh">Retry</button></div></div>`;
		case 'missing-gh-stack':
			return `<div class="empty"><p><strong>gh stack is not installed.</strong> Cairn reads and writes stacks through the official <code>gh stack</code> extension.</p>
				<div class="row-actions"><button class="btn" data-action="installGhStack">Install gh stack</button><button class="btn secondary" data-action="refresh">Retry</button></div>
				<p class="muted">Runs <code>gh extension install github/gh-stack</code>.</p></div>`;
		case 'error':
			return `<div class="empty"><p><strong>gh stack view failed</strong> (exit ${s.code}).</p><pre class="stderr">${esc(s.stderr.trim() || 'no output')}</pre>
				<div class="row-actions"><button class="btn" data-action="refresh">Retry</button><button class="btn secondary" data-action="showOutput">Show output</button></div></div>`;
		case 'no-stack':
			return noStackView(s);
		case 'ready':
			return readyView(s);
	}
}

function stackSwitcher(stacks: StackSummaryVM[]): string {
	if (stacks.length < 2) {
		return '';
	}
	const current = stacks.find(x => x.active) ?? stacks[0];
	return `<details class="menu switcher">
		<summary class="btn ghost" aria-label="Switch stack" title="Switch stack">${esc(current.label)} <span class="muted small">· ${current.size}</span></summary>
		<div class="menu-items" role="menu">
			${stacks.map(x => `<button role="menuitem" data-action="switchStack" data-branch="${esc(x.top)}" ${x.active ? 'aria-current="true"' : ''}>
				<span>${esc(x.label)}</span>
				<span class="muted small">${x.size} layer${x.size === 1 ? '' : 's'} on ${esc(x.trunk)}</span>
			</button>`).join('')}
		</div>
	</details>`;
}

function toolbar(lastFetch: number | null, extra = ''): string {
	return `<div class="toolbar" role="toolbar" aria-label="Stack actions">
		${extra}
		<button class="btn ghost" data-action="fetch" title="git fetch --prune · last fetched ${esc(ago(lastFetch))}">Fetch</button>
		<button class="btn ghost icon" data-action="refresh" title="Refresh" aria-label="Refresh">↻</button>
		<button class="btn ghost icon" data-action="showOutput" title="Show the Cairn output channel" aria-label="Show output">≡</button>
	</div>`;
}

function readyView(st: Extract<ViewState, { status: 'ready' }>): string {
	const s = st.stack;
	const layers = s.layers;
	const idx = layers.findIndex(l => l.isCurrent);
	const where = idx >= 0
		? `You are on <strong>${esc(layers[idx].name)}</strong> — ${ordinal(idx + 1)} of ${layers.length}`
		: s.currentBranch === s.trunk.name
			? `You are on <strong>${esc(s.trunk.name)}</strong>, the trunk of this ${layers.length}-layer stack`
			: `You are on <strong>${esc(s.currentBranch)}</strong>`;
	const edits = layers.filter(l => l.draft.titleEdited || l.draft.bodyEdited || ui.drafts.has(l.name)).length;
	const switcher = stackSwitcher(s.stacks);
	const githubPr = (layers[idx]?.pr?.url ? layers[idx] : [...layers].reverse().find(l => l.pr?.url))?.pr;
	const actions = `
		${githubPr ? `<button class="btn ghost" data-action="openPr" data-url="${esc(githubPr.url ?? '')}" title="Open PR #${githubPr.number} and its stack on GitHub">Open in GitHub</button>` : ''}
		<button class="btn ghost ${ui.editMode ? 'pressed' : ''}" data-action="toggleEdit" aria-pressed="${ui.editMode}" title="Edit titles and descriptions before submit (E)">Edit stack</button>
		<button class="btn" data-action="submit" title="gh stack submit --auto --remote ${esc(s.remote)}, then gh pr edit for changed cards">Submit${edits ? ` <span class="badge">${edits}</span>` : ''}</button>`;
	return `<div class="stack" data-width>
		<header class="head">
			${switcher}
			<p class="where" aria-live="polite">${where}</p>
			${toolbar(st.lastFetch, actions)}
		</header>
		${opBanner(st.op)}
		${st.builder ? branchBuilder(st.builder, { overlay: true, defaultTrunk: s.defaultTrunk }) : ''}
		${wrongLayerBanner(s)}
		${planPanel(s)}
		${s.hasMerged ? '<p class="note muted">This stack has merged layers. Reordering is off until <code>gh stack sync</code> cleans them up.</p>' : ''}
		<ol class="column" role="list" aria-label="Stack, tip at the top" data-drop-zone="stack">
			${displayLayers(s).map(l => card(l, s, movedSet(s))).join('')}
			${trunkRow(s)}
		</ol>
		${st.builder ? '' : `<button class="new-stack" data-action="openBuilder" data-drop-zone="new" title="Start another stack. Drop a branch from below to start it with that branch.">
			<span aria-hidden="true">+</span><span>New stack on <span class="mono">${esc(s.defaultTrunk)}</span></span><span class="muted small">or drop a branch here</span>
		</button>`}
		${tray(s)}
	</div>`;
}

function opBanner(op: OpVM): string {
	switch (op.kind) {
		case 'idle':
			return '';
		case 'running':
			return `<div class="banner running" role="status"><div class="progress"></div><span>${esc(op.label)}…</span></div>`;
		case 'applied':
			return `<div class="banner ok" role="status">
				<span>${op.published ? 'Published.' : 'Reorder applied locally. Nothing has been pushed.'}</span>
				<span class="row-actions">
					${op.published ? '' : '<button class="btn" data-action="publish">Publish…</button>'}
					${op.published ? '' : `<button class="btn secondary" data-action="undo" ${op.canUndo ? '' : 'disabled'} title="${esc(op.undoBlockedReason ?? 'Restore every branch and the gh-stack file')}">Undo</button>`}
					<button class="btn ghost" data-action="dismissApplied">Dismiss</button>
				</span></div>`;
		case 'conflict': {
			const where = op.branch ? ` on <strong>${esc(op.branch)}</strong>${op.step ? ` (step ${op.step} of ${op.total})` : ''}` : '';
			const title = op.interrupted
				? `The reorder stopped before it finished${where}. Abort restores the snapshot.`
				: op.source === 'cairn'
					? `Rebase paused${where}.`
					: op.source === 'gh-stack'
						? 'gh stack rebase is paused on a conflict.'
						: 'A git rebase is in progress.';
			const files = op.files.map(f => `<li class="${f.staged ? 'staged' : ''}">
				<span class="mark">${f.staged ? ICON.check : ICON.dot}</span><code>${esc(f.path)}</code>
				<span class="muted">${f.staged ? 'staged' : 'unmerged'}</span>
				${f.staged ? '' : `<button class="btn ghost" data-action="resolveFile" data-path="${esc(f.path)}">Resolve</button>`}</li>`).join('');
			const cont = op.source === 'gh-stack' ? 'gh stack rebase --continue' : 'git rebase --continue';
			return `<div class="banner warn" role="alert">
				<p>${title}</p>
				${files ? `<ul class="conflicts">${files}</ul>` : ''}
				<div class="row-actions">
					${op.interrupted ? '' : `<button class="btn" data-action="continueRebase" ${op.allStaged ? '' : 'disabled'} title="${op.allStaged ? esc(cont) : 'Stage every file first'}">Continue</button>`}
					<button class="btn secondary" data-action="abortRebase">Abort</button>
				</div></div>`;
		}
	}
}

function wrongLayerBanner(s: StackVM): string {
	const w = s.wrongLayer;
	if (!w) {
		return '';
	}
	const sig = `${w.target}|${w.files.join(',')}`;
	if (ui.dismissedWarning === sig) {
		return '';
	}
	return `<div class="banner warn" role="status">
		<p>These edits look like they belong on <strong>${esc(w.target)}</strong>, and you are on <strong>${esc(w.current)}</strong>.</p>
		<ul class="files compact">${w.files.slice(0, 5).map(f => `<li><code>${esc(f)}</code></li>`).join('')}${w.files.length > 5 ? `<li class="muted">and ${w.files.length - 5} more</li>` : ''}</ul>
		<div class="row-actions">
			<button class="btn" data-action="moveEdits" data-branch="${esc(w.target)}">Move edits to ${esc(w.target)}…</button>
			<button class="btn ghost" data-action="dismissWarning" data-sig="${esc(sig)}">Dismiss</button>
		</div></div>`;
}

function planPanel(s: StackVM): string {
	if (!isProposalActive(s)) {
		return '';
	}
	const p = ui.plan && ui.plan.order.join('\n') === proposedOrder(s).join('\n') ? ui.plan : null;
	const body = !p
		? '<p class="muted">Computing plan…</p>'
		: p.error
			? `<p class="error">${esc(p.error)}</p>`
			: `<ol class="plan">${p.plan!.steps.map(st => `<li><code>${esc(st.command)}</code><span class="muted">${esc(st.detail)}</span></li>`).join('')}</ol>
				${p.plan!.blockers.map(b => `<p class="error">${esc(b)}</p>`).join('')}
				${p.plan!.warnings.map(w => `<p class="muted">${esc(w)}</p>`).join('')}`;
	const canApply = !!p?.plan && !p.plan.noop && p.plan.blockers.length === 0;
	return `<section class="plan-panel" aria-label="Proposed order">
		<div class="plan-head"><strong>Proposed order</strong><span class="muted">Nothing runs until you apply.</span></div>
		${body}
		<div class="row-actions">
			<button class="btn" data-action="applyPlan" ${canApply ? '' : 'disabled'}>Apply locally…</button>
			<button class="btn secondary" data-action="resetOrder">Reset order</button>
		</div></section>`;
}

function ciCell(l: LayerVM): string {
	const ci = l.pr?.ci ?? 'none';
	if (!l.pr || ci === 'none') {
		return '<span class="cell ci none" aria-hidden="true"></span>';
	}
	const label = { passing: 'Checks passing', failing: 'Checks failing', pending: 'Checks running' }[ci];
	return `<span class="cell ci ${ci}" title="${label}" aria-label="${label}">${ci === 'passing' ? ICON.check : ci === 'failing' ? ICON.x : ICON.dot}<span class="label">${ci === 'passing' ? 'Passing' : ci === 'failing' ? 'Failing' : 'Running'}</span></span>`;
}

function reviewCell(l: LayerVM): string {
	const r = l.pr?.reviewDecision;
	if (!l.pr || !r) {
		return `<span class="cell review none">${l.pr?.isDraft ? '<span class="label muted">Draft</span>' : ''}</span>`;
	}
	const map = {
		APPROVED: ['approved', 'Approved', ICON.reviewApproved],
		CHANGES_REQUESTED: ['changes', 'Changes requested', ICON.reviewChanges],
		REVIEW_REQUIRED: ['required', 'Review required', ICON.reviewRequired],
	} as const;
	const [cls, label, icon] = map[r];
	return `<span class="cell review ${cls}" title="${label}" aria-label="${label}">${icon}<span class="label">${label}</span></span>`;
}

function commentsCell(l: LayerVM): string {
	const n = l.pr?.comments;
	if (n === null || n === undefined) {
		return '<span class="cell comments none"></span>';
	}
	return `<span class="cell comments ${n ? '' : 'zero'}" title="${n} comment${n === 1 ? '' : 's'}" aria-label="${n} comments">${ICON.comment}<span>${n}</span></span>`;
}

function diffCell(l: LayerVM): string {
	return `<span class="cell diff" title="${l.files.length} file${l.files.length === 1 ? '' : 's'} changed in this layer"><span class="add">+${l.additions}</span> <span class="del">−${l.deletions}</span></span>`;
}

function statusDot(l: LayerVM): string {
	let cls = 'neutral';
	let label = 'No PR yet';
	if (l.isMerged) {
		[cls, label] = ['merged', 'Merged'];
	} else if (l.needsRebase) {
		[cls, label] = ['warn', 'Needs rebase'];
	} else if (l.pr?.ci === 'failing' || l.pr?.reviewDecision === 'CHANGES_REQUESTED') {
		[cls, label] = ['failing', l.pr?.ci === 'failing' ? 'Checks failing' : 'Changes requested'];
	} else if (l.pr?.ci === 'pending') {
		[cls, label] = ['pending', 'Checks running'];
	} else if (l.pr?.ci === 'passing') {
		[cls, label] = ['passing', 'Checks passing'];
	} else if (l.pr) {
		[cls, label] = ['open', 'PR open'];
	}
	return `<span class="dot ${cls}" title="${label}" aria-label="${label}"></span>`;
}

function trackPills(l: LayerVM): string {
	const t = l.track;
	const out: string[] = [];
	if (t.gone) {
		out.push(`<span class="pill warn" title="${esc(t.upstream ?? 'upstream')} no longer exists on the remote">upstream gone</span>`);
	} else if (t.upstream) {
		if (t.ahead) {
			out.push(`<span class="pill" title="${t.ahead} local commit${t.ahead === 1 ? '' : 's'} not on ${esc(t.upstream)}">↑${t.ahead}</span>`);
		}
		if (t.behind) {
			out.push(`<span class="pill warn" title="${t.behind} commit${t.behind === 1 ? '' : 's'} on ${esc(t.upstream)} not here">↓${t.behind}</span>`);
		}
	} else if (!l.isMerged && l.pr === undefined && l.head) {
		out.push('<span class="pill quiet" title="Not pushed yet">local</span>');
	}
	return out.join('');
}

function card(l: LayerVM & { added?: boolean }, s: StackVM, moved: Set<string>): string {
	const key = l.name;
	const expanded = ui.expanded.has(key) || ui.editing.has(key) || (ui.editMode && l.isCurrent);
	const editing = !l.isMerged && (ui.editing.has(key) || (ui.editMode && l.isCurrent));
	const title = ui.drafts.get(key)?.title ?? l.draft.title;
	const node = l.isMerged ? `<span class="node merged">${ICON.check}</span>` : `<span class="node ${l.isCurrent ? 'current' : l.pr ? 'open' : 'local'}">${l.needsRebase ? '<span class="warn-dot" title="Needs rebase"></span>' : ''}</span>`;
	const draggable = !l.isMerged && !s.hasMerged && !s.rebaseInProgress;
	const classes = ['layer', l.isCurrent && 'current', l.isMerged && 'merged', moved.has(key) && 'moved', l.added && 'added', expanded && 'expanded', editing && 'editing', ui.focused === key && 'focused'].filter(Boolean).join(' ');
	const prLink = l.pr
		? `<a href="#" class="pr" data-action="openPr" data-url="${esc(l.pr.url ?? '')}" title="Open PR #${l.pr.number} on GitHub">#${l.pr.number}</a><span class="sep">·</span>`
		: '';
	const tags = [
		l.isCurrent ? '<span class="here">You are here</span>' : '',
		moved.has(key) ? `<span class="tag moved">${l.added ? 'added' : 'moved'}</span>` : '',
		l.isQueued ? '<span class="tag">queued</span>' : '',
		l.needsRebase ? '<span class="tag warn">needs rebase</span>' : '',
	].join('');
	return `<li class="${classes}" data-key="${esc(key)}" tabindex="${ui.focused === key ? 0 : -1}" ${draggable ? 'draggable="true"' : ''} aria-current="${l.isCurrent ? 'true' : 'false'}" aria-expanded="${expanded}" aria-label="${esc(`${title}, ${l.name}${l.pr ? `, PR ${l.pr.number}` : ''}${l.isCurrent ? ', current branch' : ''}${l.isMerged ? ', merged' : ''}`)}">
		${node}<span class="seg" aria-hidden="true"></span>
		<div class="card">
			<div class="row">
				${draggable ? `<span class="grip" aria-hidden="true" title="Drag to reorder (Alt+↑/↓)">${ICON.grip}</span>` : ''}
				<button class="disclose" data-action="toggle" tabindex="-1" aria-label="${expanded ? 'Collapse' : 'Expand'}">${ICON.chevron}</button>
				<div class="titles">
					<div class="primary"><span class="title">${esc(title)}</span><span class="branch-only">${esc(l.name)}</span>${tags}</div>
					<div class="secondary">${prLink}<span class="branch">${esc(l.name)}</span>${trackPills(l)}</div>
				</div>
				<div class="cluster">
					${ciCell(l)}
					${reviewCell(l)}
					${commentsCell(l)}
					${diffCell(l)}
				</div>
				${statusDot(l)}
				<div class="hover-actions">
					${l.pr?.url ? `<button class="btn ghost" data-action="openPr" data-url="${esc(l.pr.url)}" title="Open PR #${l.pr.number} on GitHub">GitHub</button>` : ''}
					${l.isCurrent || l.added ? '' : `<button class="btn ghost" data-action="checkout" data-branch="${esc(key)}" title="Check out ${esc(key)} (Enter)">Check out</button>`}
					${l.isMerged || l.added ? '' : `<button class="btn ghost" data-action="edit" data-branch="${esc(key)}" title="Edit title and description (E)">${editing ? 'Done' : 'Edit'}</button>`}
					${l.isMerged || l.isCurrent || l.added ? '' : `<button class="btn ghost" data-action="openWorktree" data-branch="${esc(key)}" title="Open ${esc(key)} in a new worktree and window">Worktree</button>`}
					${isProposalActive(s) || ui.proposed ? (l.isMerged ? '' : `<button class="btn ghost" data-action="removeFromStack" data-branch="${esc(key)}" title="Take out of the proposed stack (Delete)">Remove</button>`) : ''}
				</div>
			</div>
			${expanded ? details(l, editing) : ''}
		</div>
	</li>`;
}

function details(l: LayerVM & { added?: boolean }, editing: boolean): string {
	if (l.added) {
		return '<div class="details"><p class="muted">Added in the proposed order. Its commits are shown after Apply.</p></div>';
	}
	const draft = ui.drafts.get(l.name);
	const editor = editing
		? `<div class="editor">
			<label class="field"><span>Title</span><input type="text" data-field="title" data-branch="${esc(l.name)}" value="${esc(draft?.title ?? l.draft.title)}" placeholder="PR title"></label>
			<label class="field"><span>Description</span><textarea data-field="body" data-branch="${esc(l.name)}" rows="6" placeholder="What this layer does and why">${esc(draft?.body ?? l.draft.body)}</textarea></label>
			<p class="muted small">${l.pr ? `Saved here until Submit runs <code>gh pr edit ${l.pr.number}</code>.` : 'Used for the new PR: Submit creates it, then sets this title and description.'}</p>
		</div>`
		: '';
	const range = l.rangeBase
		? `<span class="muted small">${l.commits.length} commit${l.commits.length === 1 ? '' : 's'} since <code>${esc(l.rangeBase.slice(0, 7))}</code> (${l.rangeSource === 'recorded' ? 'recorded base' : `merge-base with ${esc(l.parent)}`})</span>`
		: '';
	const commits = l.commits.length
		? `<ol class="commits">${l.commits.map(c => `<li><code>${esc(c.short)}</code> <span>${esc(c.subject)}</span></li>`).join('')}</ol>`
		: '<p class="muted small">No commits of its own.</p>';
	const files = l.files.length
		? `<ul class="files">${l.files.map(f => `<li><button class="file" data-action="openFile" data-branch="${esc(l.name)}" data-path="${esc(f.path)}" title="${l.isCurrent ? 'Open file' : 'Open this layer\'s diff'}"><span class="path">${esc(f.path)}</span><span class="diff">${f.additions === null ? '<span class="muted">binary</span>' : `<span class="add">+${f.additions}</span> <span class="del">−${f.deletions}</span>`}</span></button></li>`).join('')}</ul>`
		: '';
	return `<div class="details">${editor}<div class="contents"><div class="contents-head"><strong>Commits</strong>${range}</div>${commits}${files ? `<div class="contents-head"><strong>Files</strong><span class="muted small">${l.files.length}</span></div>${files}` : ''}</div></div>`;
}

function trunkRow(s: StackVM): string {
	const t = s.trunk;
	const behind = t.track.behind ? `<span class="pill warn" title="${t.track.behind} commit${t.track.behind === 1 ? '' : 's'} on ${esc(t.track.upstream ?? 'upstream')} not in your local ${esc(t.name)}">${t.track.behind} behind</span>` : '';
	const isHere = s.currentBranch === t.name;
	return `<li class="layer trunk ${isHere ? 'current' : ''} ${ui.focused === 'trunk' ? 'focused' : ''}" data-key="trunk" data-branch="${esc(t.name)}" tabindex="${ui.focused === 'trunk' ? 0 : -1}" aria-label="${esc(`Trunk ${t.name}`)}" aria-current="${isHere}">
		<span class="node trunk-node"></span>
		<div class="card"><div class="row">
			<div class="titles"><div class="primary"><span class="title mono">${esc(t.name)}</span>${isHere ? '<span class="here">You are here</span>' : ''}${behind}</div></div>
			<span class="muted small trunk-label">trunk</span>
			<div class="hover-actions">${isHere ? '' : `<button class="btn ghost" data-action="checkout" data-branch="${esc(t.name)}">Check out</button>`}</div>
		</div></div>
	</li>`;
}

function tray(s: StackVM): string {
	const items = trayItems(s);
	if (items.length === 0 || s.hasMerged) {
		return '';
	}
	return `<section class="tray" data-drop-zone="tray" aria-label="Local branches not in this stack">
		<div class="tray-head"><strong>Not in this stack</strong><span class="muted small">Add to this stack, or start a new one on ${esc(s.defaultTrunk)}.</span></div>
		<ul>${items.map(i => `<li class="tray-item ${i.removed ? 'removed' : ''} ${ui.focused === `tray:${i.name}` ? 'focused' : ''}" data-key="tray:${esc(i.name)}" data-branch="${esc(i.name)}" tabindex="${ui.focused === `tray:${i.name}` ? 0 : -1}" draggable="true">
			<span class="grip" aria-hidden="true">${ICON.grip}</span><span class="mono">${esc(i.name)}</span><span class="muted small">${i.commits} commit${i.commits === 1 ? '' : 's'}${i.removed ? ' · removed from stack' : ''}</span>
			<span class="row-actions">${i.removed ? '' : `<button class="btn ghost" data-action="newStackWith" data-branch="${esc(i.name)}" title="Start a new stack on ${esc(s.defaultTrunk)} with this branch">New stack</button>`}<button class="btn ghost" data-action="addToStack" data-branch="${esc(i.name)}" title="Add on top of the proposed stack">Add</button></span>
		</li>`).join('')}</ul>
	</section>`;
}

// ---------------------------------------------------------------------------
// No stack: builder

function noStackView(st: Extract<ViewState, { status: 'no-stack' }>): string {
	const b = st.builder;
	const switcher = st.stacks.length
		? `<section class="section"><h2>${st.ambiguous ? `${esc(st.currentBranch)} is the trunk of several stacks. Pick one:` : 'Existing stacks'}</h2>
			<ul class="stack-list">${st.stacks.map(x => `<li><button class="btn ghost wide" data-action="switchStack" data-branch="${esc(x.top)}"><span class="dot open"></span><span class="mono">${esc(x.label)}</span><span class="muted small">${x.size} layer${x.size === 1 ? '' : 's'} on ${esc(x.trunk)}</span></button></li>`).join('')}</ul></section>`
		: '';
	return `<div class="stack builder-view">
		<header class="head"><p class="where"><strong>${esc(st.currentBranch)}</strong> is not part of a stack.</p>${toolbar(st.lastFetch, '')}</header>
		${opBanner(st.op)}
		${switcher}
		${branchBuilder(b)}
	</div>`;
}

function branchBuilder(b: BuilderVM, opts: { overlay?: boolean; defaultTrunk?: string } = {}): string {
	const trunk = ui.builder.trunk ?? b.trunk;
	const available = new Set(b.candidates.map(c => c.name));
	ui.builder.selected = ui.builder.selected.filter(n => available.has(n));
	const selected = ui.builder.selected;
	const unselected = b.candidates.filter(c => !selected.includes(c.name));
	const cmd = selected.length ? `gh stack init ${selected.join(' ')} --base ${trunk}` : '';
	const heading = opts.overlay ? `New stack on ${esc(trunk)}` : 'Create a stack';
	return `<section class="section ${opts.overlay ? 'new-stack-form' : ''}" aria-label="${heading}">
		<h2>${heading}</h2>
		<p class="small muted">Most stacks sit on ${esc(opts.defaultTrunk ?? b.trunk)}. 1 is the bottom layer (the first PR). Drag or add branches, then create — this does not change the stack you are looking at until you confirm.</p>
		<label class="field inline"><span>Trunk</span><select data-action="builderTrunk">${b.trunks.map(t => `<option ${t === trunk ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
		${b.candidates.length === 0 ? `<p class="muted">No local branches have commits that are not in ${esc(trunk)}.</p>` : ''}
		${selected.length ? `<p class="small muted">Order, bottom first (1 sits on ${esc(trunk)}). Alt+↑/↓ moves the focused row.</p>
			<ol class="build-order">${selected.map((n, i) => `<li data-key="build:${esc(n)}" tabindex="-1"><span class="num">${i + 1}</span><span class="mono">${esc(n)}</span>
				<span class="row-actions"><button class="btn ghost icon" data-action="buildMove" data-branch="${esc(n)}" data-dir="-1" aria-label="Move toward trunk" ${i === 0 ? 'disabled' : ''}>↑</button><button class="btn ghost icon" data-action="buildMove" data-branch="${esc(n)}" data-dir="1" aria-label="Move toward tip" ${i === selected.length - 1 ? 'disabled' : ''}>↓</button><button class="btn ghost" data-action="buildRemove" data-branch="${esc(n)}">Remove</button></span></li>`).join('')}</ol>` : ''}
		${unselected.length ? `<p class="small muted">Unstacked branches:</p><ul class="build-pool">${unselected.map(c => `<li><button class="btn ghost wide" data-action="buildAdd" data-branch="${esc(c.name)}"><span>+</span><span class="mono">${esc(c.name)}</span><span class="muted small">${c.commits} commit${c.commits === 1 ? '' : 's'}</span></button></li>`).join('')}</ul>` : ''}
		${cmd ? `<pre class="command"><code>${esc(cmd)}</code></pre>` : ''}
		${b.dirtyReason ? `<p class="error">${esc(b.dirtyReason)}</p>` : ''}
		<div class="row-actions"><button class="btn" data-action="initStack" ${selected.length && b.clean ? '' : 'disabled'}>Create stack</button>${opts.overlay ? '<button class="btn secondary" data-action="closeBuilder">Cancel</button>' : ''}</div>
	</section>`;
}

function startNewStack(branches: string[]): void {
	ui.builder.selected = [...branches];
	post({ type: 'openBuilder' });
}

// ---------------------------------------------------------------------------
// Focus and motion

function capturePositions(): Map<string, number> {
	const map = new Map<string, number>();
	root.querySelectorAll<HTMLElement>('.column > li[data-key]').forEach(el => map.set(el.dataset.key!, el.getBoundingClientRect().top));
	return map;
}

/** FLIP: cards (and their rail nodes) slide from where they were. 140ms ease-out. */
function animateFrom(before: Map<string, number>): void {
	if (reducedMotion.matches || before.size === 0) {
		return;
	}
	root.querySelectorAll<HTMLElement>('.column > li[data-key]').forEach(el => {
		const prev = before.get(el.dataset.key!);
		if (prev === undefined) {
			return;
		}
		const dy = prev - el.getBoundingClientRect().top;
		if (Math.abs(dy) < 1) {
			return;
		}
		el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 140, easing: 'ease-out' });
	});
}

interface FocusInfo {
	key?: string;
	field?: string;
	start?: number | null;
	end?: number | null;
	inCard: boolean;
}

function captureFocus(): FocusInfo {
	const a = document.activeElement as HTMLElement | null;
	if (!a || !root.contains(a)) {
		return { inCard: false };
	}
	if (a.dataset.field) {
		const input = a as HTMLInputElement;
		return { key: a.dataset.branch, field: a.dataset.field, start: input.selectionStart, end: input.selectionEnd, inCard: true };
	}
	const li = a.closest<HTMLElement>('[data-key]');
	return { key: li?.dataset.key, inCard: !!li && li === a };
}

function restoreFocus(f: FocusInfo): void {
	if (f.field && f.key) {
		const el = root.querySelector<HTMLInputElement>(`[data-field="${f.field}"][data-branch="${CSS.escape(f.key)}"]`);
		if (el) {
			el.focus();
			if (f.start !== null && f.start !== undefined) {
				el.setSelectionRange(f.start, f.end ?? f.start);
			}
		}
		return;
	}
	if (f.inCard && ui.focused) {
		root.querySelector<HTMLElement>(`[data-key="${CSS.escape(ui.focused)}"]`)?.focus();
	}
}

function focusables(): HTMLElement[] {
	return [...root.querySelectorAll<HTMLElement>('.column > li[data-key], .tray-item[data-key]')];
}

function focusKey(key: string | null): void {
	if (!key) {
		return;
	}
	ui.focused = key;
	root.querySelectorAll<HTMLElement>('[data-key]').forEach(el => {
		const on = el.dataset.key === key;
		if (el.matches('.column > li, .tray-item')) {
			el.tabIndex = on ? 0 : -1;
		}
		el.classList.toggle('focused', on);
	});
	root.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)?.focus();
}

// ---------------------------------------------------------------------------
// Proposed order

let planTimer: number | undefined;

function setProposed(order: string[] | null): void {
	const s = stackOf();
	if (!s) {
		return;
	}
	ui.proposed = order && order.join('\n') !== currentOrder(s).join('\n') ? order : null;
	ui.proposedFrom = currentOrder(s).join('\n');
	render();
	window.clearTimeout(planTimer);
	if (ui.proposed) {
		const snapshot = [...ui.proposed];
		planTimer = window.setTimeout(() => post({ type: 'previewPlan', order: snapshot }), 120);
	} else {
		ui.plan = null;
	}
}

function moveInProposal(name: string, delta: 1 | -1): void {
	const s = stackOf();
	if (!s || s.hasMerged || s.rebaseInProgress) {
		return;
	}
	const order = [...proposedOrder(s)];
	const i = order.indexOf(name);
	const j = i + delta;
	if (i < 0 || j < 0 || j >= order.length) {
		return;
	}
	[order[i], order[j]] = [order[j], order[i]];
	setProposed(order);
	focusKey(name);
}

// ---------------------------------------------------------------------------
// Events

function draftInput(el: HTMLInputElement | HTMLTextAreaElement): void {
	const branch = el.dataset.branch!;
	const field = el.dataset.field as 'title' | 'body';
	const d = { ...ui.drafts.get(branch), [field]: el.value };
	ui.drafts.set(branch, d);
	scheduleDraft(branch, field, el.value);
}

const draftTimers = new Map<string, number>();
function scheduleDraft(branch: string, field: 'title' | 'body', value: string): void {
	const key = `${branch}\0${field}`;
	window.clearTimeout(draftTimers.get(key));
	draftTimers.set(key, window.setTimeout(() => post({ type: 'setDraft', branch, [field]: value }), 300));
}

function toggleEditing(name: string): void {
	const s = stackOf();
	const layer = s?.layers.find(l => l.name === name);
	if (!layer || layer.isMerged) {
		return;
	}
	const editingNow = ui.editing.has(name) || (ui.editMode && layer.isCurrent);
	if (editingNow) {
		ui.editing.delete(name);
		if (layer.isCurrent) {
			ui.editMode = false;
		}
	} else {
		ui.editing.add(name);
	}
	persist();
	render();
	focusKey(name);
}

root.addEventListener('click', e => {
	const target = e.target as HTMLElement;
	const el = target.closest<HTMLElement>('[data-action]');
	const li = target.closest<HTMLElement>('li[data-key]');
	if (li && !target.closest('input, textarea, select, a, button, summary, .menu-items')) {
		ui.focused = li.dataset.key!;
		focusKey(ui.focused);
		if (li.closest('.column') && li.dataset.key !== 'trunk' && !target.closest('.details')) {
			toggleExpanded(li.dataset.key!);
		}
		return;
	}
	if (!el || el.tagName === 'SELECT') {
		return;
	}
	if (el.tagName === 'A') {
		e.preventDefault();
	}
	const branch = el.dataset.branch ?? '';
	const s = stackOf();
	switch (el.dataset.action) {
		case 'toggle': if (li) { toggleExpanded(li.dataset.key!); } break;
		case 'checkout': post({ type: 'checkout', branch }); break;
		case 'openPr': if (el.dataset.url) { post({ type: 'openPr', url: el.dataset.url }); } break;
		case 'openFile': post({ type: 'openFile', branch, path: el.dataset.path! }); break;
		case 'edit': toggleEditing(branch); break;
		case 'toggleEdit':
			ui.editMode = !ui.editMode;
			if (!ui.editMode) {
				ui.editing.clear();
			}
			persist();
			render();
			break;
		case 'submit': post({ type: 'submit', open: false }); break;
		case 'fetch': post({ type: 'fetch' }); break;
		case 'refresh': post({ type: 'refresh' }); break;
		case 'showOutput': post({ type: 'showOutput' }); break;
		case 'openSettings': post({ type: 'openSettings' }); break;
		case 'installGhStack': post({ type: 'installGhStack' }); break;
		case 'applyPlan': if (ui.proposed) { post({ type: 'applyPlan', order: ui.proposed }); } break;
		case 'resetOrder': setProposed(null); break;
		case 'removeFromStack': if (s) { setProposed(proposedOrder(s).filter(n => n !== branch)); } break;
		case 'addToStack': if (s) { setProposed([...proposedOrder(s), branch]); focusKey(branch); } break;
		case 'newStackWith': startNewStack([branch]); break;
		case 'openBuilder': closeMenus(); post({ type: 'openBuilder' }); break;
		case 'closeBuilder': ui.builder.selected = []; post({ type: 'closeBuilder' }); break;
		case 'undo': post({ type: 'undo' }); break;
		case 'publish': post({ type: 'publish' }); break;
		case 'dismissApplied': post({ type: 'dismissApplied' }); break;
		case 'continueRebase': post({ type: 'continueRebase' }); break;
		case 'abortRebase': post({ type: 'abortRebase' }); break;
		case 'resolveFile': post({ type: 'resolveFile', path: el.dataset.path! }); break;
		case 'moveEdits': post({ type: 'moveEdits', target: branch }); break;
		case 'dismissWarning': ui.dismissedWarning = el.dataset.sig ?? null; render(); break;
		case 'openWorktree': post({ type: 'openWorktree', branch }); break;
		case 'switchStack': {
			closeMenus();
			const current = s?.stacks.find(x => x.active);
			if (current?.top === branch) {
				break;
			}
			post({ type: 'switchStack', top: branch });
			break;
		}
		case 'buildAdd': ui.builder.selected.push(branch); render(); break;
		case 'buildRemove': ui.builder.selected = ui.builder.selected.filter(n => n !== branch); render(); break;
		case 'buildMove': moveBuild(branch, Number(el.dataset.dir) as 1 | -1); break;
		case 'initStack': {
			const b = ui.state.status === 'no-stack' || ui.state.status === 'ready' ? ui.state.builder : null;
			post({ type: 'initStack', trunk: ui.builder.trunk ?? b?.trunk ?? 'main', branches: [...ui.builder.selected] });
			break;
		}
	}
});

function closeMenus(): void {
	root.querySelectorAll('details.menu[open]').forEach(d => d.removeAttribute('open'));
}

function toggleExpanded(key: string): void {
	if (ui.expanded.has(key)) {
		ui.expanded.delete(key);
	} else {
		ui.expanded.add(key);
	}
	persist();
	render();
}

function moveBuild(name: string, delta: 1 | -1): void {
	const sel = ui.builder.selected;
	const i = sel.indexOf(name);
	const j = i + delta;
	if (i < 0 || j < 0 || j >= sel.length) {
		return;
	}
	[sel[i], sel[j]] = [sel[j], sel[i]];
	render();
	root.querySelector<HTMLElement>(`[data-key="build:${CSS.escape(name)}"]`)?.focus();
}

root.addEventListener('change', e => {
	const el = e.target as HTMLSelectElement;
	if (el.dataset.action === 'switchStack') {
		post({ type: 'switchStack', top: el.value });
	} else if (el.dataset.action === 'builderTrunk') {
		ui.builder.trunk = el.value;
		post({ type: 'builderTrunk', trunk: el.value });
	}
});

root.addEventListener('input', e => {
	const el = e.target as HTMLInputElement | HTMLTextAreaElement;
	if (el.dataset.field) {
		draftInput(el);
	}
});

root.addEventListener('dblclick', e => {
	const target = e.target as HTMLElement;
	if (target.closest('input, textarea, button, a, .details')) {
		return;
	}
	const li = target.closest<HTMLElement>('.column > li[data-key]');
	const s = stackOf();
	if (!li || !s) {
		return;
	}
	const key = li.dataset.key!;
	const branch = key === 'trunk' ? s.trunk.name : key;
	const layer = s.layers.find(l => l.name === branch);
	if (key === 'trunk' ? s.currentBranch !== branch : layer && !layer.isCurrent) {
		post({ type: 'checkout', branch });
	}
});

root.addEventListener('keydown', e => {
	const target = e.target as HTMLElement;
	if (target.matches('input, textarea, select')) {
		if (e.key === 'Escape' && target.dataset.branch) {
			(target as HTMLInputElement).blur();
			toggleEditing(target.dataset.branch);
		}
		return;
	}
	const build = target.closest<HTMLElement>('.build-order li[data-key]');
	if (build && e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
		e.preventDefault();
		moveBuild(build.dataset.key!.slice(6), e.key === 'ArrowUp' ? -1 : 1);
		return;
	}
	const li = target.closest<HTMLElement>('li[data-key]');
	if (!li || li !== target || !li.matches('.column > li, .tray-item')) {
		if (e.key === 'Escape') {
			closeMenus();
		}
		return;
	}
	const key = li.dataset.key!;
	const s = stackOf();
	const items = focusables();
	const i = items.indexOf(li);
	const isLayer = li.closest('.column') && key !== 'trunk';
	switch (e.key) {
		case 'ArrowUp':
		case 'ArrowDown': {
			e.preventDefault();
			if (e.altKey && isLayer) {
				// visual up is toward the tip, which is later in the bottom-first order
				moveInProposal(key, e.key === 'ArrowUp' ? 1 : -1);
				return;
			}
			const next = items[i + (e.key === 'ArrowUp' ? -1 : 1)];
			if (next) {
				focusKey(next.dataset.key!);
			}
			return;
		}
		case 'Home': e.preventDefault(); focusKey(items[0]?.dataset.key ?? null); return;
		case 'End': e.preventDefault(); focusKey(items[items.length - 1]?.dataset.key ?? null); return;
		case 'Enter': {
			e.preventDefault();
			if (!s) {
				return;
			}
			if (key.startsWith('tray:')) {
				setProposed([...proposedOrder(s), key.slice(5)]);
				return;
			}
			const branch = key === 'trunk' ? s.trunk.name : key;
			if (branch !== s.currentBranch && !(li.classList.contains('added'))) {
				post({ type: 'checkout', branch });
			}
			return;
		}
		case ' ':
			e.preventDefault();
			if (isLayer) {
				toggleExpanded(key);
			}
			return;
		case 'e':
		case 'E':
			if (isLayer) {
				e.preventDefault();
				toggleEditing(key);
			}
			return;
		case 'Delete':
		case 'Backspace':
			if (isLayer && s && !li.classList.contains('merged') && !s.hasMerged) {
				e.preventDefault();
				setProposed(proposedOrder(s).filter(n => n !== key));
				focusKey(focusables()[Math.min(i, focusables().length - 1)]?.dataset.key ?? null);
			}
			return;
		case 'Escape':
			if (ui.editing.size || ui.editMode) {
				ui.editing.clear();
				ui.editMode = false;
				persist();
				render();
				focusKey(key);
			} else if (ui.expanded.has(key)) {
				toggleExpanded(key);
			}
			return;
	}
});

root.addEventListener('focusin', e => {
	const li = (e.target as HTMLElement).closest<HTMLElement>('.column > li[data-key], .tray-item[data-key]');
	if (li && li === e.target) {
		ui.focused = li.dataset.key!;
		root.querySelectorAll('.focused').forEach(x => x !== li && x.classList.remove('focused'));
		li.classList.add('focused');
	}
});

// Drag and drop: updates the proposed order only.

function clearDropMarks(): void {
	root.querySelectorAll('.drop-above, .drop-below').forEach(el => el.classList.remove('drop-above', 'drop-below'));
	root.querySelector('.tray')?.classList.remove('drop-target');
	root.querySelector('.new-stack')?.classList.remove('drop-target');
}

root.addEventListener('dragstart', e => {
	const li = (e.target as HTMLElement).closest<HTMLElement>('[draggable="true"][data-key]');
	const s = stackOf();
	if (!li || !s) {
		return;
	}
	const fromTray = li.classList.contains('tray-item');
	const key = fromTray ? li.dataset.branch! : li.dataset.key!;
	ui.drag = { key, from: fromTray ? 'tray' : 'stack' };
	e.dataTransfer?.setData('text/plain', key);
	if (e.dataTransfer) {
		e.dataTransfer.effectAllowed = 'move';
	}
	li.classList.add('dragging');
	root.classList.add('is-dragging');
});

root.addEventListener('dragover', e => {
	const s = stackOf();
	if (!ui.drag || !s) {
		return;
	}
	const neu = (e.target as HTMLElement).closest('[data-drop-zone="new"]');
	clearDropMarks();
	if (neu && ui.drag.from === 'tray') {
		e.preventDefault();
		neu.classList.add('drop-target');
		ui.dropNew = true;
		ui.dropTray = false;
		ui.dropIndex = null;
		return;
	}
	const tray = (e.target as HTMLElement).closest('.tray');
	if (tray) {
		if (ui.drag.from === 'stack') {
			e.preventDefault();
			tray.classList.add('drop-target');
			ui.dropTray = true;
			ui.dropNew = false;
			ui.dropIndex = null;
		}
		return;
	}
	const column = (e.target as HTMLElement).closest('.column');
	if (!column) {
		return;
	}
	e.preventDefault();
	ui.dropTray = false;
	ui.dropNew = false;
	const cards = [...column.querySelectorAll<HTMLElement>(':scope > li[data-key]:not(.trunk):not(.merged)')];
	// cards are top-first; find the first card whose midpoint is below the pointer
	let visualIndex = cards.length;
	for (let k = 0; k < cards.length; k++) {
		const r = cards[k].getBoundingClientRect();
		if (e.clientY < r.top + r.height / 2) {
			visualIndex = k;
			break;
		}
	}
	if (cards.length === 0) {
		return;
	}
	if (visualIndex < cards.length) {
		cards[visualIndex].classList.add('drop-above');
	} else {
		cards[cards.length - 1].classList.add('drop-below');
	}
	// convert to an insertion index in the bottom-first order
	ui.dropIndex = cards.length - visualIndex;
});

root.addEventListener('drop', e => {
	e.preventDefault();
	const s = stackOf();
	const drag = ui.drag;
	if (!s || !drag) {
		return;
	}
	if (ui.dropNew) {
		endDrag();
		startNewStack([drag.key]);
		return;
	}
	let order = [...proposedOrder(s)];
	if (ui.dropTray) {
		order = order.filter(n => n !== drag.key);
	} else if (ui.dropIndex !== null) {
		const visible = order.filter(n => n !== drag.key);
		const without = order.indexOf(drag.key);
		let at = ui.dropIndex;
		if (without >= 0 && without < at) {
			at -= 1;
		}
		visible.splice(Math.max(0, Math.min(at, visible.length)), 0, drag.key);
		order = visible;
	}
	endDrag();
	setProposed(order);
	focusKey(drag.key);
});

function endDrag(): void {
	clearDropMarks();
	root.classList.remove('is-dragging');
	root.querySelectorAll('.dragging').forEach(el => el.classList.remove('dragging'));
	ui.drag = null;
	ui.dropIndex = null;
	ui.dropTray = false;
	ui.dropNew = false;
	if (ui.renderPending) {
		render();
	}
}

root.addEventListener('dragend', () => {
	if (ui.drag) {
		endDrag();
	}
});

document.addEventListener('keydown', e => {
	if (e.key === 'Escape' && ui.drag) {
		endDrag();
	}
});

// ---------------------------------------------------------------------------
// Host messages

window.addEventListener('message', (e: MessageEvent<ToWebview>) => {
	const m = e.data;
	if (m.type === 'state') {
		ui.state = m.state;
		const s = stackOf();
		if (s) {
			const known = new Set([...s.layers.map(l => l.name), ...s.candidates.map(c => c.name)]);
			if (ui.proposed && (ui.proposed.some(n => !known.has(n)) || s.hasMerged || currentOrder(s).join('\n') !== ui.proposedFrom)) {
				ui.proposed = null;
				ui.plan = null;
			}
			if (ui.proposed) {
				post({ type: 'previewPlan', order: ui.proposed });
			}
			// drop local drafts the host has caught up with
			for (const [name, d] of ui.drafts) {
				const l = s.layers.find(x => x.name === name);
				if (!l || ((d.title === undefined || d.title === l.draft.title) && (d.body === undefined || d.body === l.draft.body))) {
					ui.drafts.delete(name);
				}
			}
			if (!ui.focused || !s.layers.some(l => l.name === ui.focused) && ui.focused !== 'trunk' && !ui.focused.startsWith('tray:')) {
				ui.focused = s.layers.find(l => l.isCurrent)?.name ?? s.layers[s.layers.length - 1]?.name ?? 'trunk';
			}
		}
		render();
	} else if (m.type === 'plan') {
		ui.plan = m;
		render();
	}
});

window.setInterval(() => {
	const btn = root.querySelector<HTMLElement>('[data-action="fetch"]');
	const st = ui.state;
	if (btn && (st.status === 'ready' || st.status === 'no-stack')) {
		btn.title = `git fetch --prune · last fetched ${ago(st.lastFetch)}`;
	}
}, 30_000);

render();
post({ type: 'ready' });
