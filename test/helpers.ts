import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { Run, RunResult } from '../src/run';

export const run: Run = (cmd, args, opts) =>
	new Promise<RunResult>((resolve, reject) => {
		const child = spawn(cmd, args, {
			cwd: opts.cwd,
			env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', ...opts.env },
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', d => (stdout += d));
		child.stderr.on('data', d => (stderr += d));
		child.on('error', reject);
		child.on('close', code => resolve({ code: code ?? -1, stdout, stderr }));
		child.stdin.end(opts.input ?? '');
	});

export interface TempRepo {
	dir: string;
	/** git dir lives outside the worktree so the tests also cover non-.git layouts */
	gitDir: string;
	git(...args: string[]): Promise<string>;
	tryGit(...args: string[]): Promise<RunResult>;
	sha(ref: string): Promise<string>;
	commit(file: string, content: string, message: string): Promise<string>;
	cleanup(): void;
}

export async function makeRepo(): Promise<TempRepo> {
	const root = mkdtempSync(path.join(tmpdir(), 'cairn-test-'));
	const dir = path.join(root, 'work');
	const gitDir = path.join(root, 'repo.gitdir');
	mkdirSync(dir);
	const tryGit = (...args: string[]) => run('git', args, { cwd: dir });
	const git = async (...args: string[]) => {
		const r = await tryGit(...args);
		if (r.code !== 0) {
			throw new Error(`git ${args.join(' ')} failed (${r.code}): ${r.stderr}`);
		}
		return r.stdout.trim();
	};
	const r = await run('git', ['init', '--quiet', '--template=', '-b', 'main', `--separate-git-dir=${gitDir}`, dir], { cwd: root });
	if (r.code !== 0) {
		throw new Error(r.stderr);
	}
	await git('config', 'user.email', 'test@example.com');
	await git('config', 'user.name', 'Test');
	await git('config', 'commit.gpgsign', 'false');
	const repo: TempRepo = {
		dir,
		gitDir,
		git,
		tryGit,
		sha: ref => git('rev-parse', ref),
		async commit(file, content, message) {
			mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
			writeFileSync(path.join(dir, file), content);
			await git('add', '--', file);
			await git('commit', '--quiet', '-m', message);
			return git('rev-parse', 'HEAD');
		},
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
	return repo;
}

export interface ThreeLayer {
	repo: TempRepo;
	trunkTip: string;
	auth: { head: string; base: string };
	api: { head: string; base: string };
	ui: { head: string; base: string };
}

/** main <- auth <- api <- ui, one commit each, files that do not overlap. */
export async function makeThreeLayerStack(): Promise<ThreeLayer> {
	const repo = await makeRepo();
	const trunkTip = await repo.commit('README.md', 'base\n', 'init');
	await repo.git('checkout', '--quiet', '-b', 'auth');
	const auth = await repo.commit('src/auth.ts', 'export const auth = 1;\n', 'Add auth middleware');
	await repo.git('checkout', '--quiet', '-b', 'api');
	const api = await repo.commit('src/api.ts', 'export const api = 1;\n', 'Add API routes');
	await repo.git('checkout', '--quiet', '-b', 'ui');
	const ui = await repo.commit('src/ui.tsx', 'export const ui = 1;\n', 'Add UI');
	return {
		repo,
		trunkTip,
		auth: { head: auth, base: trunkTip },
		api: { head: api, base: auth },
		ui: { head: ui, base: api },
	};
}

/** Writes a catalog the way gh stack init does, plus an unknown key to prove it survives. */
export function writeCatalog(gitDir: string, s: ThreeLayer, extra: Record<string, unknown> = {}): string {
	const catalog = {
		schemaVersion: 1,
		repository: 'github.com:octo/demo',
		futureTopLevel: { keep: true },
		stacks: [
			{
				id: 'stack-1',
				number: 7,
				trunk: { branch: 'main', head: s.trunkTip },
				branches: [
					{ branch: 'auth', base: s.auth.base, pullRequest: { number: 11, url: 'https://github.com/octo/demo/pull/11' }, futureBranchKey: 'auth-x' },
					{ branch: 'api', base: s.api.base, pullRequest: { number: 12, url: 'https://github.com/octo/demo/pull/12' } },
					{ branch: 'ui', base: s.ui.base },
				],
				futureStackKey: [1, 2, 3],
			},
		],
		...extra,
	};
	const text = JSON.stringify(catalog, null, 2);
	writeFileSync(path.join(gitDir, 'gh-stack'), text);
	return text;
}

/** Subjects of the commits a branch has on top of its parent ref. */
export async function ownCommits(repo: TempRepo, parent: string, branch: string): Promise<string[]> {
	const out = await repo.git('log', '--format=%s', `${parent}..${branch}`);
	return out ? out.split('\n') : [];
}
