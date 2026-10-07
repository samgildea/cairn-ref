import type { CiState, ReviewDecision } from './protocol';
import type { Run } from './run';

export interface PrDetails {
	number: number;
	title: string;
	body: string;
	url: string;
	isDraft: boolean;
	state: string;
	reviewDecision: ReviewDecision;
	ci: CiState;
	comments: number;
	additions: number;
	deletions: number;
	baseRefName: string;
}

const FIELDS = 'number,title,body,url,isDraft,state,reviewDecision,statusCheckRollup,comments,reviews,additions,deletions,baseRefName';

type RollupItem = {
	__typename?: string;
	status?: string;
	conclusion?: string | null;
	state?: string;
};

const FAIL = new Set(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
const PENDING_STATE = new Set(['PENDING', 'EXPECTED']);

/** Collapses a statusCheckRollup list into one state. Pure. */
export function summarizeRollup(items: RollupItem[] | null | undefined): CiState {
	if (!items || items.length === 0) {
		return 'none';
	}
	let pending = false;
	for (const it of items) {
		if (it.__typename === 'StatusContext' || (it.state && !it.status)) {
			const s = (it.state ?? '').toUpperCase();
			if (FAIL.has(s)) {
				return 'failing';
			}
			if (PENDING_STATE.has(s)) {
				pending = true;
			}
			continue;
		}
		if ((it.status ?? '').toUpperCase() !== 'COMPLETED') {
			pending = true;
			continue;
		}
		if (FAIL.has((it.conclusion ?? '').toUpperCase())) {
			return 'failing';
		}
	}
	return pending ? 'pending' : 'passing';
}

function normalizeReview(v: unknown): ReviewDecision {
	return v === 'APPROVED' || v === 'CHANGES_REQUESTED' || v === 'REVIEW_REQUIRED' ? v : null;
}

/**
 * Supplementary PR reads. One `gh pr view` per PR, cached by number. Refreshed
 * on first load, on Fetch, on stack switch, and after submit; never on HEAD changes.
 */
export class PrCache {
	private readonly cache = new Map<number, PrDetails>();
	/** numbers already read (or tried) since the last forced refresh */
	private readonly attempted = new Set<number>();
	private inflight: Promise<void> | null = null;

	constructor(private readonly run: Run, private readonly gh: () => string) {}

	get(n: number): PrDetails | undefined {
		return this.cache.get(n);
	}

	clear(): void {
		this.cache.clear();
		this.attempted.clear();
	}

	async refresh(cwd: string, numbers: number[], opts: { force: boolean }): Promise<void> {
		if (this.inflight) {
			await this.inflight;
		}
		const todo = numbers.filter(n => opts.force || !this.attempted.has(n));
		todo.forEach(n => this.attempted.add(n));
		if (todo.length === 0) {
			return;
		}
		this.inflight = Promise.all(todo.map(n => this.readOne(cwd, n))).then(() => undefined);
		try {
			await this.inflight;
		} finally {
			this.inflight = null;
		}
	}

	private async readOne(cwd: string, n: number): Promise<void> {
		const r = await this.run(this.gh(), ['pr', 'view', String(n), '--json', FIELDS], { cwd, quiet: true });
		if (r.code !== 0) {
			return;
		}
		try {
			const j = JSON.parse(r.stdout);
			const reviewsWithText = Array.isArray(j.reviews) ? j.reviews.filter((x: { body?: string }) => (x.body ?? '').trim()).length : 0;
			this.cache.set(n, {
				number: j.number,
				title: j.title ?? '',
				body: j.body ?? '',
				url: j.url ?? '',
				isDraft: !!j.isDraft,
				state: j.state ?? '',
				reviewDecision: normalizeReview(j.reviewDecision),
				ci: summarizeRollup(j.statusCheckRollup),
				comments: (Array.isArray(j.comments) ? j.comments.length : 0) + reviewsWithText,
				additions: j.additions ?? 0,
				deletions: j.deletions ?? 0,
				baseRefName: j.baseRefName ?? '',
			});
		} catch {
			// leave the cache entry absent; the card falls back to gh-stack data
		}
	}
}
