import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { branchesWithoutPr, ordinal, parseStackView, StackParseError, stackProblems } from '../src/stack';

const fixture = (name: string) => readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

describe('parseStackView', () => {
	it('parses gh-stack v0.1.1 output, which omits head', () => {
		const view = parseStackView(fixture('view-v0.1.1.json'));
		expect(view.trunk).toBe('main');
		expect(view.currentBranch).toBe('ui');
		expect(view.branches.map(b => b.name)).toEqual(['auth', 'api', 'ui']);
		expect(view.branches[0].head).toBeUndefined();
		expect(view.branches[1].base).toBe('213b6f23c190b02a1b2a10cdd091c16ce65cd770');
		expect(view.branches[2].isCurrent).toBe(true);
		expect(view.branches.every(b => b.pr === undefined)).toBe(true);
	});

	it('parses PRs, merged, queued, and needsRebase', () => {
		const view = parseStackView(fixture('view-with-prs.json'));
		const [schema, auth, api, ui] = view.branches;
		expect(schema).toMatchObject({ isMerged: true, pr: { number: 120, state: 'MERGED' } });
		expect(auth).toMatchObject({ isQueued: true, pr: { state: 'QUEUED' } });
		expect(api).toMatchObject({ isCurrent: true, needsRebase: true, head: '3333333333333333333333333333333333333333' });
		expect(api.pr?.url).toBe('https://github.com/octo/demo/pull/123');
		expect(ui.pr).toBeUndefined();
	});

	it('rejects stderr text and malformed shapes', () => {
		expect(() => parseStackView('✗ current branch "x" is not part of a stack')).toThrow(StackParseError);
		expect(() => parseStackView('[]')).toThrow(StackParseError);
		expect(() => parseStackView('{"trunk":"main","currentBranch":"a"}')).toThrow(/branches/);
		expect(() => parseStackView('{"trunk":"main","currentBranch":"a","branches":[{"name":"a","pr":{"number":1,"state":"CLOSED"}}]}')).toThrow(/CLOSED/);
	});
});

describe('branchesWithoutPr', () => {
	it('lists only open layers that have no PR', () => {
		const view = parseStackView(JSON.stringify({
			trunk: 'video-ui',
			currentBranch: 'b',
			branches: [
				{ name: 'merged', isMerged: true, pr: { number: 1, state: 'MERGED' } },
				{ name: 'queued', isQueued: true },
				{ name: 'a', pr: { number: 2, state: 'OPEN' } },
				{ name: 'b' },
			],
		}));
		expect(branchesWithoutPr(view)).toEqual(['b']);
	});
});

describe('stackProblems', () => {
	it('keeps the warning and error lines from a submit that exited 0', () => {
		const stderr = [
			'Checking stack state...',
			'Pushing to origin...',
			'\x1b[33m\u26a0\x1b[0m failed to create PR for video-ux-updates: HTTP 422: Validation Failed (base)',
			'\u2713 Pushed and synced 1 branches',
		].join('\n');
		expect(stackProblems(stderr)).toEqual(['\u26a0 failed to create PR for video-ux-updates: HTTP 422: Validation Failed (base)']);
	});
});

describe('ordinal', () => {
	it('formats positions', () => {
		expect([1, 2, 3, 4, 11, 12, 13, 21, 22].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd']);
	});
});
