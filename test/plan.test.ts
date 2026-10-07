import { afterEach, describe, expect, it } from 'vitest';
import { forkPoint, Git } from '../src/git';
import { computePlan, describePlan, PlanError, type Plan, type PlanInput, type RebaseStep } from '../src/plan';
import { makeThreeLayerStack, ownCommits, run, type ThreeLayer } from './helpers';

function inputFor(s: ThreeLayer, proposed: string[]): PlanInput {
	return {
		trunk: { name: 'main', tip: s.trunkTip },
		current: [
			{ name: 'auth', ...s.auth },
			{ name: 'api', ...s.api },
			{ name: 'ui', ...s.ui },
		],
		proposed,
	};
}

async function execute(s: ThreeLayer, steps: RebaseStep[]): Promise<void> {
	for (const step of steps) {
		const r = await s.repo.tryGit(...step.argv);
		if (r.code !== 0) {
			throw new Error(`git ${step.argv.join(' ')} failed: ${r.stderr}`);
		}
	}
}

/** Each branch in `order` has exactly its own single commit on top of the branch below it. */
async function layerContents(s: ThreeLayer, order: string[]): Promise<Record<string, string[]>> {
	const out: Record<string, string[]> = {};
	for (let i = 0; i < order.length; i++) {
		const parent = i === 0 ? s.trunkTip : order[i - 1];
		out[order[i]] = await ownCommits(s.repo, parent, order[i]);
	}
	return out;
}

let stack: ThreeLayer | undefined;
afterEach(() => stack?.repo.cleanup());

describe('computePlan — moving auth from the bottom to the top of auth → api → ui', () => {
	it('uses each branch\'s recorded base SHA as the upstream, never a branch name', async () => {
		stack = await makeThreeLayerStack();
		const plan = computePlan(inputFor(stack, ['api', 'ui', 'auth']));

		expect(plan.steps.map(st => st.argv)).toEqual([
			['rebase', '--onto', stack.trunkTip, stack.api.base, 'api'],
			['rebase', '--onto', 'api', stack.ui.base, 'ui'],
			['rebase', '--onto', 'ui', stack.auth.base, 'auth'],
		]);
		for (const st of plan.steps) {
			expect(st.upstream).toMatch(/^[0-9a-f]{40}$/);
			expect(['main', 'auth', 'api', 'ui']).not.toContain(st.upstream);
		}
		expect(plan.metadata.order).toEqual([
			{ branch: 'api', base: { kind: 'parent-tip', parent: null } },
			{ branch: 'ui', base: { kind: 'parent-tip', parent: 'api' } },
			{ branch: 'auth', base: { kind: 'parent-tip', parent: 'ui' } },
		]);
		expect(plan.moved).toEqual(['api', 'ui', 'auth']);
	});

	it('leaves exactly one commit on each branch when the plan runs against a real repo', async () => {
		stack = await makeThreeLayerStack();
		const plan = computePlan(inputFor(stack, ['api', 'ui', 'auth']));
		await execute(stack, plan.steps);

		expect(await layerContents(stack, ['api', 'ui', 'auth'])).toEqual({
			api: ['Add API routes'],
			ui: ['Add UI'],
			auth: ['Add auth middleware'],
		});
	});

	it('a plan that passes parent branch names as the upstream absorbs another layer\'s commits', async () => {
		stack = await makeThreeLayerStack();
		const plan = computePlan(inputFor(stack, ['api', 'ui', 'auth']));
		const originalParent: Record<string, string> = { auth: 'main', api: 'auth', ui: 'api' };
		const byName: RebaseStep[] = plan.steps.map(st => ({
			...st,
			upstream: originalParent[st.branch],
			argv: ['rebase', '--onto', st.onto, originalParent[st.branch], st.branch],
		}));
		await execute(stack, byName);

		const contents = await layerContents(stack, ['api', 'ui', 'auth']);
		// The name "api" now points at the rewritten api, so ui's replay range
		// picks up auth's commit and auth ends up empty.
		expect(contents.ui).toEqual(['Add UI', 'Add auth middleware']);
		expect(contents.auth).toEqual([]);
		expect(contents).not.toEqual({ api: ['Add API routes'], ui: ['Add UI'], auth: ['Add auth middleware'] });
	});
});

describe('computePlan — other shapes', () => {
	it('returns a no-op for the current order', async () => {
		stack = await makeThreeLayerStack();
		const plan = computePlan(inputFor(stack, ['auth', 'api', 'ui']));
		expect(plan.noop).toBe(true);
		expect(plan.steps).toEqual([]);
		expect(describePlan(plan, '/x/gh-stack')).toEqual([]);
	});

	it('swapping the top two only rebases those two', async () => {
		stack = await makeThreeLayerStack();
		const plan = computePlan(inputFor(stack, ['auth', 'ui', 'api']));
		expect(plan.steps.map(st => st.branch)).toEqual(['ui', 'api']);
		expect(plan.metadata.order[0]).toEqual({ branch: 'auth', base: { kind: 'keep', sha: stack.auth.base } });
		await execute(stack, plan.steps);
		expect(await layerContents(stack, ['auth', 'ui', 'api'])).toEqual({
			auth: ['Add auth middleware'],
			ui: ['Add UI'],
			api: ['Add API routes'],
		});
	});

	it('dropping the middle layer replays the one above onto the one below and keeps the branch', async () => {
		stack = await makeThreeLayerStack();
		const plan = computePlan(inputFor(stack, ['auth', 'ui']));
		expect(plan.removed).toEqual(['api']);
		expect(plan.steps.map(st => st.argv)).toEqual([['rebase', '--onto', 'auth', stack.ui.base, 'ui']]);
		await execute(stack, plan.steps);
		expect(await ownCommits(stack.repo, 'auth', 'ui')).toEqual(['Add UI']);
		expect(await stack.repo.sha('api')).toBe(stack.api.head);
	});

	it('inserts an unstacked branch using its fork point', async () => {
		stack = await makeThreeLayerStack();
		await stack.repo.git('checkout', '--quiet', '-b', 'docs', stack.trunkTip);
		const docs = await stack.repo.commit('docs/readme.md', 'docs\n', 'Add docs');
		const plan = computePlan({
			...inputFor(stack, ['auth', 'docs', 'api', 'ui']),
			candidates: [{ name: 'docs', head: docs, base: stack.trunkTip }],
		});
		expect(plan.added).toEqual(['docs']);
		expect(plan.steps.map(st => st.branch)).toEqual(['docs', 'api', 'ui']);
		await execute(stack, plan.steps);
		expect(await layerContents(stack, ['auth', 'docs', 'api', 'ui'])).toEqual({
			auth: ['Add auth middleware'],
			docs: ['Add docs'],
			api: ['Add API routes'],
			ui: ['Add UI'],
		});
	});

	it('stacks a branch forked from an older commit of a layer that has since moved on', async () => {
		stack = await makeThreeLayerStack();
		const s = stack;
		const oldAuth = s.auth.head;
		await s.repo.git('checkout', '--quiet', '-b', 'privacy', oldAuth);
		const privacy = await s.repo.commit('content/privacy.md', 'privacy\n', 'Add privacy policy');
		await s.repo.git('checkout', '--quiet', 'auth');
		const newAuth = await s.repo.commit('src/auth.ts', 'export const auth = 2;\n', 'Tighten auth');

		const git = new Git(run, s.repo.dir);
		expect(await git.isAncestor(newAuth, privacy)).toBe(false);
		const base = await forkPoint(git, 'main', [newAuth, s.api.head, s.ui.head], privacy);
		expect(base).toBe(oldAuth);
		expect(base).not.toBe(s.trunkTip);

		const plan = computePlan({
			...inputFor(s, ['auth', 'privacy', 'api', 'ui']),
			current: [
				{ name: 'auth', head: newAuth, base: s.trunkTip },
				{ name: 'api', ...s.api },
				{ name: 'ui', ...s.ui },
			],
			candidates: [{ name: 'privacy', head: privacy, base: base! }],
		});
		expect(plan.steps[0]).toMatchObject({ branch: 'privacy', upstream: oldAuth, argv: ['rebase', '--onto', 'auth', oldAuth, 'privacy'] });

		await execute(s, plan.steps);
		expect(await ownCommits(s.repo, 'auth', 'privacy')).toEqual(['Add privacy policy']);
		expect(await layerContents(s, ['auth', 'privacy', 'api', 'ui'])).toEqual({
			auth: ['Tighten auth', 'Add auth middleware'],
			privacy: ['Add privacy policy'],
			api: ['Add API routes'],
			ui: ['Add UI'],
		});
	});

	it('falls back to the trunk fork point when a branch shares no history with any layer', async () => {
		stack = await makeThreeLayerStack();
		await stack.repo.git('checkout', '--quiet', '-b', 'docs', stack.trunkTip);
		const docs = await stack.repo.commit('docs/readme.md', 'docs\n', 'Add docs');
		const git = new Git(run, stack.repo.dir);
		expect(await forkPoint(git, 'main', [stack.auth.head, stack.api.head, stack.ui.head], docs)).toBe(stack.trunkTip);
	});

	it('refuses stacks with merged branches, duplicates, unknown branches, and non-SHA bases', async () => {
		stack = await makeThreeLayerStack();
		const base = inputFor(stack, ['api', 'auth', 'ui']);
		expect(() => computePlan({ ...base, current: base.current.map((b, i) => (i === 0 ? { ...b, isMerged: true } : b)) })).toThrow(/merged/);
		expect(() => computePlan({ ...base, proposed: ['auth', 'auth'] })).toThrow(/twice/);
		expect(() => computePlan({ ...base, proposed: ['auth', 'nope'] })).toThrow(/not a local branch/);
		expect(() => computePlan({ ...base, current: base.current.map((b, i) => (i === 1 ? { ...b, base: 'auth' } : b)) })).toThrow(PlanError);
		expect(() => computePlan({ ...base, proposed: ['main'] })).toThrow(/trunk/);
	});

	it('describes the plan as the commands that will run', async () => {
		stack = await makeThreeLayerStack();
		const plan: Plan = computePlan(inputFor(stack, ['api', 'ui', 'auth']));
		const lines = describePlan(plan, '/repo/.git/gh-stack');
		expect(lines.map(l => l.command)).toEqual([
			`git rebase --onto ${stack.trunkTip} ${stack.api.base} api`,
			`git rebase --onto api ${stack.ui.base} ui`,
			`git rebase --onto ui ${stack.auth.base} auth`,
			'write /repo/.git/gh-stack',
		]);
	});
});
