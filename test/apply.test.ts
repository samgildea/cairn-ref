import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ApplyEngine, type Session, type Store } from '../src/apply';
import { Git } from '../src/git';
import { computePlan } from '../src/plan';
import { makeThreeLayerStack, ownCommits, run, writeCatalog, type ThreeLayer } from './helpers';

function memoryStore(): Store {
	let s: Session | undefined;
	return { get: () => s, set: async v => { s = v; } };
}

async function engineFor(stack: ThreeLayer) {
	const dirs = await new Git(run, stack.repo.dir).dirs();
	return new ApplyEngine(run, dirs, memoryStore());
}

function planFor(stack: ThreeLayer, proposed: string[]) {
	return computePlan({
		trunk: { name: 'main', tip: stack.trunkTip },
		current: [
			{ name: 'auth', ...stack.auth },
			{ name: 'api', ...stack.api },
			{ name: 'ui', ...stack.ui },
		],
		proposed,
	});
}

const ctx = (stack: ThreeLayer) => ({ trunk: 'main', trunkTip: stack.trunkTip, originalOrder: ['auth', 'api', 'ui'], branches: ['auth', 'api', 'ui'] });

let stack: ThreeLayer | undefined;
afterEach(() => stack?.repo.cleanup());

describe('ApplyEngine', () => {
	it('applies a reorder, rewrites gh-stack to match, and Undo restores refs and bytes', async () => {
		stack = await makeThreeLayerStack();
		const originalBytes = writeCatalog(stack.repo.gitDir, stack);
		const engine = await engineFor(stack);

		const result = await engine.start(planFor(stack, ['api', 'ui', 'auth']), ctx(stack));
		expect(result).toEqual({ kind: 'applied' });
		expect(await stack.repo.git('symbolic-ref', '--short', 'HEAD')).toBe('ui');

		const catalog = JSON.parse(readFileSync(path.join(stack.repo.gitDir, 'gh-stack'), 'utf8'));
		const branches = catalog.stacks[0].branches;
		expect(branches.map((b: { branch: string }) => b.branch)).toEqual(['api', 'ui', 'auth']);
		expect(branches[0].base).toBe(stack.trunkTip);
		expect(branches[1].base).toBe(await stack.repo.sha('api'));
		expect(branches[2].base).toBe(await stack.repo.sha('ui'));
		expect(branches[2].pullRequest).toEqual({ number: 11, url: 'https://github.com/octo/demo/pull/11' });
		expect(catalog.futureTopLevel).toEqual({ keep: true });
		for (const b of branches) {
			expect(await ownCommits(stack.repo, b.base, b.branch)).toHaveLength(1);
		}

		expect(await engine.undoBlocker()).toBeNull();
		await engine.undo();
		expect(await stack.repo.sha('auth')).toBe(stack.auth.head);
		expect(await stack.repo.sha('api')).toBe(stack.api.head);
		expect(await stack.repo.sha('ui')).toBe(stack.ui.head);
		expect(readFileSync(path.join(stack.repo.gitDir, 'gh-stack'), 'utf8')).toBe(originalBytes);
		expect(engine.session).toBeUndefined();
	});

	it('withdraws Undo once the result was published', async () => {
		stack = await makeThreeLayerStack();
		writeCatalog(stack.repo.gitDir, stack);
		const engine = await engineFor(stack);
		await engine.start(planFor(stack, ['auth', 'ui', 'api']), ctx(stack));
		await engine.markPublished();
		expect(await engine.undoBlocker()).toMatch(/pushed or submitted/);
		await expect(engine.undo()).rejects.toThrow(/cannot undo/);
	});

	it('pauses on conflict, continues after the file is staged, and finishes the plan', async () => {
		stack = await makeThreeLayerStack();
		// api edits auth's file, so replaying api without auth conflicts
		await stack.repo.git('checkout', '--quiet', 'api');
		await stack.repo.git('reset', '--quiet', '--hard', stack.auth.head);
		const api = await stack.repo.commit('src/auth.ts', 'export const auth = 2;\n', 'Change auth from api');
		await stack.repo.git('checkout', '--quiet', 'ui');
		await stack.repo.git('reset', '--quiet', '--hard', api);
		const ui = await stack.repo.commit('src/ui.tsx', 'ui\n', 'Add UI');
		stack.api = { head: api, base: stack.auth.head };
		stack.ui = { head: ui, base: api };
		writeCatalog(stack.repo.gitDir, stack);
		const engine = await engineFor(stack);

		const paused = await engine.start(planFor(stack, ['api', 'ui', 'auth']), ctx(stack));
		expect(paused).toMatchObject({ kind: 'conflict', branch: 'api', step: 1, total: 3 });
		expect(paused.kind === 'conflict' && paused.files).toEqual(['src/auth.ts']);
		expect(engine.inFlight).toBe(true);

		const early = await engine.continue();
		expect(early).toMatchObject({ kind: 'failed', restored: false });

		writeFileSync(path.join(stack.repo.dir, 'src/auth.ts'), 'export const auth = 2;\n');
		await stack.repo.git('add', 'src/auth.ts');
		const second = await engine.continue();
		// auth's "create src/auth.ts" now lands on a tree where api already created it
		expect(second).toMatchObject({ kind: 'conflict', branch: 'auth', step: 3, files: ['src/auth.ts'] });

		writeFileSync(path.join(stack.repo.dir, 'src/auth.ts'), 'export const auth = 3;\n');
		await stack.repo.git('add', 'src/auth.ts');
		expect(await engine.continue()).toEqual({ kind: 'applied' });
		expect(await ownCommits(stack.repo, stack.trunkTip, 'api')).toEqual(['Change auth from api']);
		expect(await ownCommits(stack.repo, 'api', 'ui')).toEqual(['Add UI']);
		expect(await ownCommits(stack.repo, 'ui', 'auth')).toEqual(['Add auth middleware']);
		const catalog = JSON.parse(readFileSync(path.join(stack.repo.gitDir, 'gh-stack'), 'utf8'));
		expect(catalog.stacks[0].branches.map((b: { branch: string }) => b.branch)).toEqual(['api', 'ui', 'auth']);
	});

	it('Abort restores every branch and the original gh-stack bytes', async () => {
		stack = await makeThreeLayerStack();
		await stack.repo.git('checkout', '--quiet', 'api');
		await stack.repo.git('reset', '--quiet', '--hard', stack.auth.head);
		const api = await stack.repo.commit('src/auth.ts', 'export const auth = 2;\n', 'Change auth from api');
		await stack.repo.git('checkout', '--quiet', 'ui');
		await stack.repo.git('reset', '--quiet', '--hard', api);
		const ui = await stack.repo.commit('src/ui.tsx', 'ui\n', 'Add UI');
		stack.api = { head: api, base: stack.auth.head };
		stack.ui = { head: ui, base: api };
		const originalBytes = writeCatalog(stack.repo.gitDir, stack);
		const engine = await engineFor(stack);

		const paused = await engine.start(planFor(stack, ['api', 'ui', 'auth']), ctx(stack));
		expect(paused.kind).toBe('conflict');
		await engine.abort();

		expect(await stack.repo.sha('auth')).toBe(stack.auth.head);
		expect(await stack.repo.sha('api')).toBe(api);
		expect(await stack.repo.sha('ui')).toBe(ui);
		expect(await stack.repo.git('symbolic-ref', '--short', 'HEAD')).toBe('ui');
		expect(readFileSync(path.join(stack.repo.gitDir, 'gh-stack'), 'utf8')).toBe(originalBytes);
		expect(engine.session).toBeUndefined();
	});

	it('refuses an unfamiliar schemaVersion before touching any branch', async () => {
		stack = await makeThreeLayerStack();
		writeFileSync(path.join(stack.repo.gitDir, 'gh-stack'), '{"schemaVersion":99,"stacks":[]}');
		const engine = await engineFor(stack);
		await expect(engine.start(planFor(stack, ['api', 'ui', 'auth']), ctx(stack))).rejects.toThrow(/schemaVersion 99/);
		expect(await stack.repo.sha('api')).toBe(stack.api.head);
	});
});
