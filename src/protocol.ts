// Shared between the extension host and the webview. Keep this file free of
// Node and vscode imports so the webview bundle can include it.

export type CiState = 'passing' | 'failing' | 'pending' | 'none';
export type ReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;

export interface FileStat {
	path: string;
	/** null for binary files */
	additions: number | null;
	deletions: number | null;
}

export interface CommitInfo {
	sha: string;
	short: string;
	subject: string;
}

export interface PrVM {
	number: number;
	url?: string;
	state: 'OPEN' | 'MERGED' | 'QUEUED';
	title?: string;
	body?: string;
	isDraft?: boolean;
	reviewDecision: ReviewDecision;
	ci: CiState;
	comments: number | null;
	baseRefName?: string;
	/** true once a GitHub read has supplemented the gh-stack data */
	detailed: boolean;
}

export interface TrackVM {
	upstream?: string;
	ahead: number;
	behind: number;
	gone: boolean;
}

export interface LayerVM {
	name: string;
	head: string;
	/** recorded base SHA from gh stack */
	base: string;
	/** the commit the layer's range starts from (recorded base, or merge-base when the record is unusable) */
	rangeBase: string;
	rangeSource: 'recorded' | 'merge-base';
	parent: string;
	isCurrent: boolean;
	isMerged: boolean;
	isQueued: boolean;
	needsRebase: boolean;
	pr?: PrVM;
	track: TrackVM;
	commits: CommitInfo[];
	files: FileStat[];
	additions: number;
	deletions: number;
	/** prefilled values; titleEdited/bodyEdited say whether the user changed them in the panel */
	draft: { title: string; body: string; titleEdited: boolean; bodyEdited: boolean };
}

export interface TrunkVM {
	name: string;
	track: TrackVM;
}

export interface StackSummaryVM {
	key: string;
	label: string;
	top: string;
	trunk: string;
	size: number;
	active: boolean;
}

export interface CandidateVM {
	name: string;
	head: string;
	commits: number;
}

export interface WrongLayerVM {
	target: string;
	current: string;
	files: string[];
}

export interface ConflictFileVM {
	path: string;
	staged: boolean;
}

export type OpVM =
	| { kind: 'idle' }
	| { kind: 'running'; label: string }
	| {
		kind: 'conflict';
		source: 'cairn' | 'gh-stack' | 'git';
		branch?: string;
		step?: number;
		total?: number;
		files: ConflictFileVM[];
		allStaged: boolean;
		/** an apply stopped without a rebase in progress (window closed mid-run); only Abort is safe */
		interrupted?: boolean;
	}
	| { kind: 'applied'; canUndo: boolean; undoBlockedReason?: string; published: boolean };

export interface PlanStepVM {
	kind: 'rebase' | 'metadata';
	command: string;
	detail: string;
	branch?: string;
}

export interface PlanVM {
	steps: PlanStepVM[];
	moved: string[];
	added: string[];
	removed: string[];
	noop: boolean;
	/** reasons the plan cannot be applied right now; empty when it can */
	blockers: string[];
	warnings: string[];
}

export interface BuilderVM {
	trunks: string[];
	trunk: string;
	candidates: CandidateVM[];
	clean: boolean;
	dirtyReason?: string;
}

export type ViewState =
	| { status: 'loading'; message?: string }
	| { status: 'no-repo' }
	| { status: 'missing-gh'; ghPath: string }
	| { status: 'missing-gh-stack' }
	| { status: 'error'; code: number; stderr: string; command: string }
	| ({ status: 'no-stack'; currentBranch: string; stacks: StackSummaryVM[]; ambiguous: boolean; builder: BuilderVM } & Common)
	| ({ status: 'ready'; stack: StackVM; builder: BuilderVM | null } & Common);

interface Common {
	repoName: string;
	lastFetch: number | null;
	op: OpVM;
}

export interface StackVM {
	trunk: TrunkVM;
	currentBranch: string;
	/** bottom (next to trunk) first */
	layers: LayerVM[];
	stacks: StackSummaryVM[];
	candidates: CandidateVM[];
	dirty: { tracked: string[]; untracked: string[] };
	wrongLayer: WrongLayerVM | null;
	rebaseInProgress: boolean;
	hasMerged: boolean;
	remote: string;
	/** where a new stack starts by default: origin's HEAD branch, else main/master */
	defaultTrunk: string;
}

// ---------------------------------------------------------------------------
// Messages

export type ToHost =
	| { type: 'ready' }
	| { type: 'refresh' }
	| { type: 'fetch' }
	| { type: 'checkout'; branch: string }
	| { type: 'openPr'; url: string }
	| { type: 'openFile'; branch: string; path: string }
	/** only the fields the user changed; null drops that field's draft */
	| { type: 'setDraft'; branch: string; title?: string | null; body?: string | null }
	| { type: 'submit'; open: boolean }
	| { type: 'previewPlan'; order: string[] }
	| { type: 'applyPlan'; order: string[] }
	| { type: 'undo' }
	| { type: 'dismissApplied' }
	| { type: 'publish' }
	| { type: 'continueRebase' }
	| { type: 'abortRebase' }
	| { type: 'resolveFile'; path: string }
	| { type: 'moveEdits'; target: string }
	| { type: 'switchStack'; top: string }
	| { type: 'builderTrunk'; trunk: string }
	| { type: 'openBuilder' }
	| { type: 'closeBuilder' }
	| { type: 'initStack'; trunk: string; branches: string[] }
	| { type: 'openWorktree'; branch: string }
	| { type: 'installGhStack' }
	| { type: 'showOutput' }
	| { type: 'openSettings' };

export type ToWebview =
	| { type: 'state'; state: ViewState }
	| { type: 'plan'; order: string[]; plan: PlanVM | null; error?: string };
