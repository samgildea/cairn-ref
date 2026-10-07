import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	checksumOf,
	findStackIndex,
	listCatalogStacks,
	MetadataError,
	parseCatalog,
	rewriteStack,
	serializeCatalog,
	snapshotStackFile,
	writeStackFileLocked,
} from '../src/metadata';
import { makeThreeLayerStack, run, writeCatalog, type ThreeLayer } from './helpers';

let stack: ThreeLayer | undefined;
afterEach(() => stack?.repo.cleanup());

describe('schema guard', () => {
	it('accepts version 1 and refuses anything else', () => {
		expect(() => parseCatalog('{"schemaVersion":1,"stacks":[]}')).not.toThrow();
		for (const bad of ['{"schemaVersion":2,"stacks":[]}', '{"schemaVersion":0,"stacks":[]}', '{"stacks":[]}', '{"schemaVersion":"1","stacks":[]}']) {
			expect(() => parseCatalog(bad)).toThrow(MetadataError);
		}
		try {
			parseCatalog('{"schemaVersion":2,"stacks":[]}');
		} catch (e) {
			expect((e as MetadataError).code).toBe('schema');
		}
		expect(() => parseCatalog('not json')).toThrow(/not valid JSON/);
	});
});

describe('rewriteStack', () => {
	it('reorders, sets bases, and carries unknown keys and PR records through', async () => {
		stack = await makeThreeLayerStack();
		const original = writeCatalog(stack.repo.gitDir, stack);
		const catalog = parseCatalog(original);
		const idx = findStackIndex(catalog, 'main', ['auth', 'api', 'ui']);
		expect(idx).toBe(0);

		const next = rewriteStack(catalog, idx, [
			{ branch: 'api', base: 'a'.repeat(40) },
			{ branch: 'ui', base: 'b'.repeat(40) },
			{ branch: 'auth', base: 'c'.repeat(40) },
		]);
		const out = JSON.parse(serializeCatalog(next));
		expect(out.futureTopLevel).toEqual({ keep: true });
		expect(out.repository).toBe('github.com:octo/demo');
		expect(out.stacks[0].futureStackKey).toEqual([1, 2, 3]);
		expect(out.stacks[0].id).toBe('stack-1');
		expect(out.stacks[0].trunk).toEqual({ branch: 'main', head: stack.trunkTip });
		expect(out.stacks[0].branches).toEqual([
			{ branch: 'api', base: 'a'.repeat(40), pullRequest: { number: 12, url: 'https://github.com/octo/demo/pull/12' } },
			{ branch: 'ui', base: 'b'.repeat(40) },
			{ branch: 'auth', base: 'c'.repeat(40), pullRequest: { number: 11, url: 'https://github.com/octo/demo/pull/11' }, futureBranchKey: 'auth-x' },
		]);
		// the input object is not mutated
		expect(JSON.parse(original).stacks[0].branches[0].branch).toBe('auth');
	});

	it('lists stacks for the switcher', async () => {
		stack = await makeThreeLayerStack();
		const catalog = parseCatalog(writeCatalog(stack.repo.gitDir, stack));
		expect(listCatalogStacks(catalog)).toEqual([
			expect.objectContaining({ index: 0, number: 7, trunk: 'main', branches: [
				expect.objectContaining({ branch: 'auth', prNumber: 11 }),
				expect.objectContaining({ branch: 'api', prNumber: 12 }),
				expect.objectContaining({ branch: 'ui' }),
			] }),
		]);
	});
});

describe('writeStackFileLocked', () => {
	it('writes under the gh-stack locks when the checksum still matches', async () => {
		stack = await makeThreeLayerStack();
		writeCatalog(stack.repo.gitDir, stack);
		const snap = await snapshotStackFile(stack.repo.gitDir);
		await writeStackFileLocked({ run, commonDir: stack.repo.gitDir, expectedChecksum: snap.checksum, data: '{"schemaVersion":1,"stacks":[]}' });
		expect(readFileSync(path.join(stack.repo.gitDir, 'gh-stack'), 'utf8')).toBe('{"schemaVersion":1,"stacks":[]}');
		expect(existsSync(path.join(stack.repo.gitDir, 'gh-stack.lock'))).toBe(true);
		expect(existsSync(path.join(stack.repo.gitDir, 'gh-stack-operation.lock'))).toBe(true);
	});

	it('refuses to write when the file changed since it was read', async () => {
		stack = await makeThreeLayerStack();
		writeCatalog(stack.repo.gitDir, stack);
		const snap = await snapshotStackFile(stack.repo.gitDir);
		writeFileSync(path.join(stack.repo.gitDir, 'gh-stack'), '{"schemaVersion":1,"stacks":[],"other":"writer"}');
		await expect(writeStackFileLocked({ run, commonDir: stack.repo.gitDir, expectedChecksum: snap.checksum, data: 'x' }))
			.rejects.toMatchObject({ code: 'stale' });
		expect(readFileSync(path.join(stack.repo.gitDir, 'gh-stack'), 'utf8')).toContain('writer');
	});

	it('restores the verbatim original bytes, and removes a file that did not exist', async () => {
		stack = await makeThreeLayerStack();
		const weird = Buffer.from('{\n    "schemaVersion": 1,\n "stacks": [] , "z": "\u00e9"\n}\n\n');
		writeFileSync(path.join(stack.repo.gitDir, 'gh-stack'), weird);
		const snap = await snapshotStackFile(stack.repo.gitDir);
		await writeStackFileLocked({ run, commonDir: stack.repo.gitDir, expectedChecksum: snap.checksum, data: '{}' });
		await writeStackFileLocked({ run, commonDir: stack.repo.gitDir, expectedChecksum: '-', data: snap.bytes });
		expect(readFileSync(path.join(stack.repo.gitDir, 'gh-stack')).equals(weird)).toBe(true);

		await writeStackFileLocked({ run, commonDir: stack.repo.gitDir, expectedChecksum: checksumOf(weird), data: null });
		expect(existsSync(path.join(stack.repo.gitDir, 'gh-stack'))).toBe(false);
	});
});
