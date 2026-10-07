import { Git, rebaseState, type GitDirs } from './git';
import {
	findStackIndex,
	parseCatalog,
	rewriteStack,
	serializeCatalog,
	snapshotStackFile,
	writeStackFileLocked,
	type RewriteEntry,
} from './metadata';
import type { MetadataStep, Plan, RebaseStep } from './plan';
import type { Run } from './run';

export interface Snapshot {
	/** every branch the plan can touch, plus every stack branch */
	refs: Record<string, string>;
	originalBranch: string | null;
	originalHead: string;
	/** base64 of the verbatim gh-stack bytes; null when the file did not exist */
	stackFile: string | null;
}

export interface Session {
	commonDir: string;
	snapshot: Snapshot;
	steps: RebaseStep[];
	metadata: MetadataStep;
	trunk: string;
	trunkTip: string;
	/** branch order in the catalog before the apply, to find the stack entry again */
	originalOrder: string[];
	next: number;
	phase: 'running' | 'conflict' | 'applied';
	postRefs?: Record<string, string>;
	published: boolean;
}

export interface Store {
	get(): Session | undefined;
	set(session: Session | undefined): Promise<void>;
}

export type ApplyResult =
	| { kind: 'applied' }
	| { kind: 'conflict'; branch: string; step: number; total: number; files: string[] }
	| { kind: 'failed'; message: string; restored: boolean };

const REBASE_ENV = { GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' };

export class ApplyEngine {
	private readonly git: Git;

	constructor(private readonly run: Run, private readonly dirs: GitDirs, private readonly store: Store) {
		this.git = new Git(run, dirs.topLevel);
	}

	get session(): Session | undefined {
		const s = this.store.get();
		return s && s.commonDir === this.dirs.commonDir ? s : undefined;
	}

	get inFlight(): boolean {
		const s = this.session;
		return !!s && (s.phase === 'running' || s.phase === 'conflict');
	}

	async start(plan: Plan, ctx: { trunk: string; trunkTip: string; originalOrder: string[]; branches: string[] }): Promise<ApplyResult> {
		if (this.inFlight) {
			return { kind: 'failed', message: 'an apply is already in flight', restored: false };
		}
		const refs: Record<string, string> = {};
		for (const b of new Set([...ctx.branches, ...plan.metadata.order.map(o => o.branch)])) {
			const sha = await this.git.revParse(`refs/heads/${b}`);
			if (!sha) {
				return { kind: 'failed', message: `branch ${b} does not exist`, restored: false };
			}
			refs[b] = sha;
		}
		const file = await snapshotStackFile(this.dirs.commonDir);
		if (file.bytes) {
			parseCatalog(file.bytes);
		}
		const snapshot: Snapshot = {
			refs,
			originalBranch: await this.git.currentBranch(),
			originalHead: (await this.git.revParse('HEAD')) ?? '',
			stackFile: file.bytes ? file.bytes.toString('base64') : null,
		};
		await this.store.set({
			commonDir: this.dirs.commonDir,
			snapshot,
			steps: plan.steps,
			metadata: plan.metadata,
			trunk: ctx.trunk,
			trunkTip: ctx.trunkTip,
			originalOrder: ctx.originalOrder,
			next: 0,
			phase: 'running',
			published: false,
		});
		return this.runSteps();
	}

	private async update(patch: Partial<Session>): Promise<Session> {
		const next = { ...this.session!, ...patch };
		await this.store.set(next);
		return next;
	}

	private async runSteps(): Promise<ApplyResult> {
		let s = this.session!;
		while (s.next < s.steps.length) {
			const step = s.steps[s.next];
			const r = await this.git.raw(step.argv, { quiet: false, env: REBASE_ENV });
			if (r.code !== 0) {
				if ((await rebaseState(this.dirs)).kind === 'git') {
					await this.update({ phase: 'conflict' });
					return { kind: 'conflict', branch: step.branch, step: s.next + 1, total: s.steps.length, files: await this.git.unmergedFiles() };
				}
				return this.failAndRestore(`git ${step.argv.join(' ')} failed: ${r.stderr.trim()}`);
			}
			s = await this.update({ next: s.next + 1, phase: 'running' });
		}
		try {
			await this.writeMetadata(s);
		} catch (e) {
			return this.failAndRestore((e as Error).message);
		}
		if (s.snapshot.originalBranch) {
			await this.git.raw(['checkout', '--quiet', s.snapshot.originalBranch], { quiet: false });
		}
		const postRefs: Record<string, string> = {};
		for (const b of Object.keys(s.snapshot.refs)) {
			postRefs[b] = (await this.git.revParse(`refs/heads/${b}`)) ?? '';
		}
		await this.update({ phase: 'applied', postRefs });
		return { kind: 'applied' };
	}

	private async writeMetadata(s: Session): Promise<void> {
		const file = await snapshotStackFile(this.dirs.commonDir);
		if (!file.bytes) {
			throw new Error('the gh-stack file disappeared while the plan ran');
		}
		const catalog = parseCatalog(file.bytes);
		const index = findStackIndex(catalog, s.trunk, s.originalOrder);
		const entries: RewriteEntry[] = [];
		for (const o of s.metadata.order) {
			const head = await this.git.revParse(`refs/heads/${o.branch}`);
			if (!head) {
				throw new Error(`branch ${o.branch} vanished while the plan ran`);
			}
			let base: string;
			if (o.base.kind === 'keep') {
				base = o.base.sha;
			} else if (o.base.parent === null) {
				base = s.trunkTip;
			} else {
				const parentTip = await this.git.revParse(`refs/heads/${o.base.parent}`);
				if (!parentTip) {
					throw new Error(`branch ${o.base.parent} vanished while the plan ran`);
				}
				base = parentTip;
			}
			entries.push({ branch: o.branch, base, head });
		}
		const next = rewriteStack(catalog, index, entries);
		await writeStackFileLocked({ run: this.run, commonDir: this.dirs.commonDir, expectedChecksum: file.checksum, data: serializeCatalog(next) });
	}

	async continue(): Promise<ApplyResult> {
		const s = this.session;
		if (!s || s.phase !== 'conflict') {
			return { kind: 'failed', message: 'no paused apply to continue', restored: false };
		}
		const unmerged = await this.git.unmergedFiles();
		if (unmerged.length > 0) {
			return { kind: 'failed', message: `stage these files first: ${unmerged.join(', ')}`, restored: false };
		}
		const r = await this.git.raw(['rebase', '--continue'], { quiet: false, env: REBASE_ENV });
		if (r.code !== 0) {
			if ((await rebaseState(this.dirs)).kind === 'git') {
				const step = s.steps[s.next];
				return { kind: 'conflict', branch: step.branch, step: s.next + 1, total: s.steps.length, files: await this.git.unmergedFiles() };
			}
			return this.failAndRestore(`git rebase --continue failed: ${r.stderr.trim()}`);
		}
		await this.update({ next: s.next + 1, phase: 'running' });
		return this.runSteps();
	}

	async abort(): Promise<void> {
		const s = this.session;
		if (!s) {
			return;
		}
		await this.restore(s.snapshot);
		await this.store.set(undefined);
	}

	/** Why Undo is unavailable, or null when it can run. */
	async undoBlocker(): Promise<string | null> {
		const s = this.session;
		if (!s || s.phase !== 'applied') {
			return 'nothing to undo';
		}
		if (s.published) {
			return 'the result was pushed or submitted; Undo is local only';
		}
		for (const [b, sha] of Object.entries(s.postRefs ?? {})) {
			const now = await this.git.revParse(`refs/heads/${b}`);
			if (now !== sha) {
				return `${b} moved after the apply`;
			}
		}
		const st = await this.git.status();
		if (st.tracked.length > 0) {
			return 'the worktree has uncommitted changes';
		}
		return null;
	}

	async undo(): Promise<void> {
		const blocker = await this.undoBlocker();
		if (blocker) {
			throw new Error(`cannot undo: ${blocker}`);
		}
		await this.restore(this.session!.snapshot);
		await this.store.set(undefined);
	}

	async markPublished(): Promise<void> {
		if (this.session?.phase === 'applied') {
			await this.update({ published: true });
		}
	}

	async dismiss(): Promise<void> {
		if (this.session?.phase === 'applied') {
			await this.store.set(undefined);
		}
	}

	private async failAndRestore(message: string): Promise<ApplyResult> {
		const s = this.session!;
		try {
			await this.restore(s.snapshot);
			await this.store.set(undefined);
			return { kind: 'failed', message, restored: true };
		} catch (e) {
			return { kind: 'failed', message: `${message}; restoring the snapshot also failed: ${(e as Error).message}`, restored: false };
		}
	}

	/** Puts every branch back on its snapshot SHA and the gh-stack file back to its original bytes. */
	private async restore(snapshot: Snapshot): Promise<void> {
		if ((await rebaseState(this.dirs)).kind === 'git') {
			await this.git.ok(['rebase', '--abort'], { quiet: false });
		}
		await this.git.ok(['checkout', '--quiet', '--detach'], { quiet: false });
		for (const [b, sha] of Object.entries(snapshot.refs)) {
			await this.git.ok(['update-ref', `refs/heads/${b}`, sha], { quiet: false });
		}
		if (snapshot.originalBranch) {
			await this.git.ok(['checkout', '--quiet', snapshot.originalBranch], { quiet: false });
		} else {
			await this.git.ok(['checkout', '--quiet', '--detach', snapshot.originalHead], { quiet: false });
		}
		await writeStackFileLocked({
			run: this.run,
			commonDir: this.dirs.commonDir,
			expectedChecksum: '-',
			data: snapshot.stackFile === null ? null : Buffer.from(snapshot.stackFile, 'base64'),
		});
	}
}
