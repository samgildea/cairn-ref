import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { CommitInfo, FileStat, TrackVM } from './protocol';
import type { Run } from './run';
import { GH_STACK_JOURNALS } from './metadata';

export interface GitDirs {
	topLevel: string;
	gitDir: string;
	commonDir: string;
}

export class GitError extends Error {
	constructor(readonly args: string[], readonly code: number, readonly stderr: string) {
		super(`git ${args.join(' ')} exited ${code}: ${stderr.trim()}`);
	}
}

export class Git {
	constructor(private readonly run: Run, readonly cwd: string) {}

	async raw(args: string[], opts: { quiet?: boolean; env?: Record<string, string> } = {}) {
		return this.run('git', args, { cwd: this.cwd, quiet: opts.quiet ?? true, env: opts.env });
	}

	async ok(args: string[], opts: { quiet?: boolean; env?: Record<string, string> } = {}): Promise<string> {
		const r = await this.raw(args, opts);
		if (r.code !== 0) {
			throw new GitError(args, r.code, r.stderr);
		}
		return r.stdout;
	}

	async dirs(): Promise<GitDirs> {
		const out = await this.ok(['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir']);
		const [topLevel, gitDir, common] = out.split('\n').map(s => s.trim());
		return { topLevel, gitDir, commonDir: path.resolve(this.cwd, common) };
	}

	async currentBranch(): Promise<string | null> {
		const r = await this.raw(['symbolic-ref', '--quiet', '--short', 'HEAD']);
		return r.code === 0 ? r.stdout.trim() : null;
	}

	async revParse(ref: string): Promise<string | null> {
		const r = await this.raw(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
		return r.code === 0 ? r.stdout.trim() : null;
	}

	async isAncestor(a: string, b: string): Promise<boolean> {
		const r = await this.raw(['merge-base', '--is-ancestor', a, b]);
		return r.code === 0;
	}

	/** Asks the remote itself, not the local tracking ref. null when the remote could not be reached. */
	async remoteHasBranch(remote: string, branch: string): Promise<boolean | null> {
		const r = await this.raw(['ls-remote', '--exit-code', '--heads', remote, `refs/heads/${branch}`]);
		if (r.code === 0) {
			return true;
		}
		return r.code === 2 ? false : null;
	}

	async mergeBase(a: string, b: string): Promise<string | null> {
		const r = await this.raw(['merge-base', a, b]);
		return r.code === 0 ? r.stdout.trim() : null;
	}

	async status(): Promise<{ tracked: string[]; untracked: string[]; unmerged: string[] }> {
		const out = await this.ok(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
		const tracked: string[] = [];
		const untracked: string[] = [];
		const unmerged: string[] = [];
		const parts = out.split('\0');
		for (let i = 0; i < parts.length; i++) {
			const entry = parts[i];
			if (entry.length < 4) {
				continue;
			}
			const xy = entry.slice(0, 2);
			const file = entry.slice(3);
			if (xy === '??') {
				untracked.push(file);
				continue;
			}
			if (xy === '!!') {
				continue;
			}
			if (xy.includes('U') || xy === 'AA' || xy === 'DD') {
				unmerged.push(file);
			}
			tracked.push(file);
			if (xy[0] === 'R' || xy[0] === 'C') {
				i++;
			}
		}
		return { tracked, untracked, unmerged };
	}

	async unmergedFiles(): Promise<string[]> {
		const out = await this.ok(['diff', '--name-only', '--diff-filter=U', '-z']);
		return out.split('\0').filter(Boolean);
	}

	/** One read of refs/heads with upstream tracking from local refs/remotes. No network. */
	async branchRefs(): Promise<Map<string, { sha: string; track: TrackVM }>> {
		const out = await this.ok([
			'for-each-ref',
			'--format=%(refname:short)%00%(objectname)%00%(upstream:short)%00%(upstream:track,nobracket)',
			'refs/heads',
		]);
		const map = new Map<string, { sha: string; track: TrackVM }>();
		for (const line of out.split('\n')) {
			if (!line) {
				continue;
			}
			const [name, sha, upstream, trackText] = line.split('\0');
			map.set(name, { sha, track: parseTrack(upstream, trackText) });
		}
		return map;
	}

	async localBranchesNotMergedInto(trunk: string): Promise<string[]> {
		const out = await this.ok(['for-each-ref', '--format=%(refname:short)', `--no-merged=${trunk}`, 'refs/heads']);
		return out.split('\n').filter(n => n && n !== trunk);
	}

	async log(base: string, head: string, limit = 200): Promise<CommitInfo[]> {
		const out = await this.ok(['log', `--max-count=${limit}`, '--format=%H%x00%h%x00%s', `${base}..${head}`]);
		return out.split('\n').filter(Boolean).map(l => {
			const [sha, short, subject] = l.split('\0');
			return { sha, short, subject };
		});
	}

	async numstat(base: string, head: string): Promise<FileStat[]> {
		const out = await this.ok(['diff', '--numstat', '-z', '--no-renames', `${base}...${head}`]);
		return parseNumstatZ(out);
	}

	async commitMessage(sha: string): Promise<{ subject: string; body: string }> {
		const out = await this.ok(['show', '-s', '--format=%s%x00%b', sha]);
		const [subject, body = ''] = out.split('\0');
		return { subject: subject.trim(), body: body.trim() };
	}

	async defaultTrunk(): Promise<string | null> {
		const r = await this.raw(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
		if (r.code === 0) {
			return r.stdout.trim().replace(/^origin\//, '');
		}
		for (const name of ['main', 'master', 'trunk', 'develop']) {
			if (await this.revParse(`refs/heads/${name}`)) {
				return name;
			}
		}
		return null;
	}
}

/**
 * The commit a branch's own work starts from. A layer can gain commits after the branch
 * forked from it, so its tip is no longer an ancestor; the merge-base with that layer still
 * finds the old fork commit. Takes the newest such merge-base that is not already on the
 * trunk, and falls back to the trunk only when the branch shares nothing else with the stack.
 */
export async function forkPoint(git: Git, trunk: string, layerHeads: string[], head: string): Promise<string | null> {
	let best: string | null = null;
	for (const layer of layerHeads) {
		const mb = await git.mergeBase(layer, head);
		if (!mb || mb === best || (await git.isAncestor(mb, trunk))) {
			continue;
		}
		if (!best || (await git.isAncestor(best, mb))) {
			best = mb;
		}
	}
	return best ?? git.mergeBase(trunk, head);
}

export function parseTrack(upstream: string | undefined, trackText: string | undefined): TrackVM {
	const t = trackText ?? '';
	return {
		upstream: upstream || undefined,
		ahead: Number(/ahead (\d+)/.exec(t)?.[1] ?? 0),
		behind: Number(/behind (\d+)/.exec(t)?.[1] ?? 0),
		gone: t.includes('gone'),
	};
}

export function parseNumstatZ(out: string): FileStat[] {
	const files: FileStat[] = [];
	for (const rec of out.split('\0')) {
		if (!rec) {
			continue;
		}
		const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(rec);
		if (!m) {
			continue;
		}
		files.push({
			path: m[3].replace(/^\n/, ''),
			additions: m[1] === '-' ? null : Number(m[1]),
			deletions: m[2] === '-' ? null : Number(m[2]),
		});
	}
	return files;
}

async function exists(p: string): Promise<boolean> {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}

export type RebaseState =
	| { kind: 'none' }
	| { kind: 'git' }
	| { kind: 'gh-stack'; journal: string };

/** A plain git rebase in this worktree, or a gh-stack operation journal in the common dir. */
export async function rebaseState(dirs: GitDirs): Promise<RebaseState> {
	for (const journal of GH_STACK_JOURNALS) {
		for (const dir of new Set([dirs.commonDir, dirs.gitDir])) {
			if (await exists(path.join(dir, journal))) {
				return { kind: 'gh-stack', journal };
			}
		}
	}
	if (await exists(path.join(dirs.gitDir, 'rebase-merge')) || await exists(path.join(dirs.gitDir, 'rebase-apply'))) {
		return { kind: 'git' };
	}
	return { kind: 'none' };
}

export async function lastFetchTime(dirs: GitDirs): Promise<number | null> {
	for (const dir of new Set([dirs.gitDir, dirs.commonDir])) {
		try {
			return (await fs.stat(path.join(dir, 'FETCH_HEAD'))).mtimeMs;
		} catch {
			// try the next location
		}
	}
	return null;
}

/** What gh stack submit --auto titles a multi-commit branch: each - and _ becomes a space. */
export function humanizeBranch(name: string): string {
	return name.replace(/[-_]/g, ' ');
}
