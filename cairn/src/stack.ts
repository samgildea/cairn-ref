import type { Run } from './run';

export interface StackPr {
	number: number;
	url?: string;
	state: 'OPEN' | 'MERGED' | 'QUEUED';
}

export interface StackBranch {
	name: string;
	/** older gh-stack releases omit head; resolve it from refs/heads when absent */
	head?: string;
	base?: string;
	isCurrent: boolean;
	isMerged: boolean;
	isQueued: boolean;
	needsRebase: boolean;
	pr?: StackPr;
}

export interface StackView {
	trunk: string;
	currentBranch: string;
	/** bottom (next to trunk) first, as gh stack prints them */
	branches: StackBranch[];
}

export const EXIT = {
	ok: 0,
	generic: 1,
	notInStack: 2,
	conflict: 3,
	api: 4,
	badArgs: 5,
	ambiguous: 6,
	rebaseActive: 7,
	locked: 8,
	stacksUnavailable: 9,
	modifyRecovery: 10,
} as const;

const EXIT_TEXT: Record<number, string> = {
	1: 'generic error',
	2: 'not in a stack',
	3: 'rebase conflict',
	4: 'GitHub API failure',
	5: 'invalid arguments',
	6: 'branch belongs to several stacks',
	7: 'rebase already in progress',
	8: 'stack file locked by another gh stack process',
	9: 'stacked PRs are not enabled on this repository',
	10: 'an interrupted gh stack modify session needs recovery (gh stack modify --abort)',
};

export function describeExit(code: number): string {
	return EXIT_TEXT[code] ?? `exit code ${code}`;
}

export class StackParseError extends Error {}

const PR_STATES = new Set(['OPEN', 'MERGED', 'QUEUED']);

function str(v: unknown, field: string): string {
	if (typeof v !== 'string') {
		throw new StackParseError(`expected ${field} to be a string`);
	}
	return v;
}

function optStr(v: unknown, field: string): string | undefined {
	if (v === undefined || v === null || v === '') {
		return undefined;
	}
	return str(v, field);
}

function bool(v: unknown): boolean {
	return v === true;
}

/** Parses the stdout of `gh stack view --json`. Pure. */
export function parseStackView(stdout: string): StackView {
	let raw: unknown;
	try {
		raw = JSON.parse(stdout);
	} catch (e) {
		throw new StackParseError(`gh stack view --json did not print JSON: ${(e as Error).message}`);
	}
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		throw new StackParseError('expected a JSON object');
	}
	const o = raw as Record<string, unknown>;
	if (!Array.isArray(o.branches)) {
		throw new StackParseError('expected branches to be an array');
	}
	const branches = o.branches.map((b, i): StackBranch => {
		if (typeof b !== 'object' || b === null) {
			throw new StackParseError(`branches[${i}] is not an object`);
		}
		const r = b as Record<string, unknown>;
		let pr: StackPr | undefined;
		if (r.pr !== undefined && r.pr !== null) {
			const p = r.pr as Record<string, unknown>;
			if (typeof p.number !== 'number' || !Number.isInteger(p.number)) {
				throw new StackParseError(`branches[${i}].pr.number is not an integer`);
			}
			const state = str(p.state, `branches[${i}].pr.state`);
			if (!PR_STATES.has(state)) {
				throw new StackParseError(`branches[${i}].pr.state "${state}" is not OPEN, MERGED, or QUEUED`);
			}
			pr = { number: p.number, url: optStr(p.url, 'pr.url'), state: state as StackPr['state'] };
		}
		return {
			name: str(r.name, `branches[${i}].name`),
			head: optStr(r.head, `branches[${i}].head`),
			base: optStr(r.base, `branches[${i}].base`),
			isCurrent: bool(r.isCurrent),
			isMerged: bool(r.isMerged),
			isQueued: bool(r.isQueued),
			needsRebase: bool(r.needsRebase),
			pr,
		};
	});
	return {
		trunk: str(o.trunk, 'trunk'),
		currentBranch: str(o.currentBranch, 'currentBranch'),
		branches,
	};
}

export type ViewOutcome =
	| { kind: 'ok'; view: StackView }
	| { kind: 'not-in-stack'; stderr: string }
	| { kind: 'ambiguous'; stderr: string }
	| { kind: 'error'; code: number; stderr: string };

/** Runs `gh stack view --json`. Never the bare form: under a PTY it opens a TUI. */
export async function readStackView(run: Run, gh: string, cwd: string): Promise<ViewOutcome> {
	const r = await run(gh, ['stack', 'view', '--json'], { cwd, quiet: true });
	if (r.code === EXIT.notInStack) {
		return { kind: 'not-in-stack', stderr: r.stderr };
	}
	if (r.code === EXIT.ambiguous) {
		return { kind: 'ambiguous', stderr: r.stderr };
	}
	if (r.code !== EXIT.ok) {
		return { kind: 'error', code: r.code, stderr: r.stderr };
	}
	try {
		return { kind: 'ok', view: parseStackView(r.stdout) };
	} catch (e) {
		return { kind: 'error', code: r.code, stderr: (e as Error).message };
	}
}

/** Unmerged, unqueued branches that still have no PR. gh stack submit exits 0 even when it could not create one. */
export function branchesWithoutPr(view: StackView): string[] {
	return view.branches.filter(b => !b.isMerged && !b.isQueued && !b.pr).map(b => b.name);
}

/** The ⚠ and ✗ lines gh-stack printed, without the ✓ and progress noise. */
export function stackProblems(stderr: string): string[] {
	return stderr
		.split('\n')
		.map(l => l.replace(/\x1b\[[0-9;]*m/g, '').trim())
		.filter(l => l.startsWith('\u26a0') || l.startsWith('\u2717'));
}

/** "1st", "2nd", "3rd", "11th" */
export function ordinal(n: number): string {
	const mod100 = n % 100;
	if (mod100 >= 11 && mod100 <= 13) {
		return `${n}th`;
	}
	switch (n % 10) {
		case 1: return `${n}st`;
		case 2: return `${n}nd`;
		case 3: return `${n}rd`;
		default: return `${n}th`;
	}
}
