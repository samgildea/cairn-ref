import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { Run } from './run';

export const STACK_FILE = 'gh-stack';
export const SUPPORTED_SCHEMA_VERSION = 1;

/** Journals that mean another gh-stack operation owns the repository right now. */
export const GH_STACK_JOURNALS = ['gh-stack-rebase-state', 'gh-stack-modify-state', 'gh-stack-migration'] as const;

export class MetadataError extends Error {
	constructor(message: string, readonly code: 'schema' | 'parse' | 'not-found' | 'locked' | 'stale' | 'io') {
		super(message);
	}
}

/** JSON values from the catalog. Objects keep keys this extension does not know about. */
type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type JsonObject = { [k: string]: Json };

export interface StackFileSnapshot {
	path: string;
	/** verbatim bytes, or null when the file did not exist */
	bytes: Buffer | null;
	checksum: string;
}

export interface CatalogBranch {
	branch: string;
	base?: string;
	head?: string;
	prNumber?: number;
}

export interface CatalogStack {
	index: number;
	number?: number;
	trunk: string;
	trunkHead?: string;
	branches: CatalogBranch[];
}

export function stackFilePath(commonDir: string): string {
	return path.join(commonDir, STACK_FILE);
}

export function checksumOf(bytes: Buffer | null): string {
	return bytes === null ? 'absent' : createHash('sha256').update(bytes).digest('hex');
}

export async function snapshotStackFile(commonDir: string): Promise<StackFileSnapshot> {
	const p = stackFilePath(commonDir);
	let bytes: Buffer | null = null;
	try {
		bytes = await fs.readFile(p);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw new MetadataError(`could not read ${p}: ${(e as Error).message}`, 'io');
		}
	}
	return { path: p, bytes, checksum: checksumOf(bytes) };
}

/** Parses catalog bytes and refuses any schemaVersion this extension was not written for. */
export function parseCatalog(bytes: Buffer | string): JsonObject {
	let json: unknown;
	try {
		json = JSON.parse(bytes.toString());
	} catch (e) {
		throw new MetadataError(`gh-stack file is not valid JSON: ${(e as Error).message}`, 'parse');
	}
	if (typeof json !== 'object' || json === null || Array.isArray(json)) {
		throw new MetadataError('gh-stack file is not a JSON object', 'parse');
	}
	const obj = json as JsonObject;
	if (obj.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
		throw new MetadataError(
			`gh-stack file has schemaVersion ${JSON.stringify(obj.schemaVersion)}; this extension only writes version ${SUPPORTED_SCHEMA_VERSION}. Nothing was changed.`,
			'schema',
		);
	}
	if (!Array.isArray(obj.stacks)) {
		throw new MetadataError('gh-stack file has no stacks array', 'parse');
	}
	return obj;
}

function asObject(v: Json | undefined): JsonObject | null {
	return typeof v === 'object' && v !== null && !Array.isArray(v) ? v : null;
}

/** Read-only view of every stack in the catalog, for the switcher. */
export function listCatalogStacks(catalog: JsonObject): CatalogStack[] {
	const stacks = catalog.stacks as Json[];
	return stacks.flatMap((s, index): CatalogStack[] => {
		const o = asObject(s);
		const trunk = asObject(o?.trunk);
		if (!o || !trunk || typeof trunk.branch !== 'string' || !Array.isArray(o.branches)) {
			return [];
		}
		const branches = o.branches.flatMap((b): CatalogBranch[] => {
			const bo = asObject(b);
			if (!bo || typeof bo.branch !== 'string') {
				return [];
			}
			const pr = asObject(bo.pullRequest);
			return [{
				branch: bo.branch,
				base: typeof bo.base === 'string' ? bo.base : undefined,
				head: typeof bo.head === 'string' ? bo.head : undefined,
				prNumber: typeof pr?.number === 'number' ? pr.number : undefined,
			}];
		});
		return [{
			index,
			number: typeof o.number === 'number' && o.number > 0 ? o.number : undefined,
			trunk: trunk.branch,
			trunkHead: typeof trunk.head === 'string' ? trunk.head : undefined,
			branches,
		}];
	});
}

/** Finds the catalog entry whose trunk and branch order match what gh stack view reported. */
export function findStackIndex(catalog: JsonObject, trunk: string, branches: string[]): number {
	const stacks = listCatalogStacks(catalog);
	const exact = stacks.find(s => s.trunk === trunk && s.branches.map(b => b.branch).join('\n') === branches.join('\n'));
	if (exact) {
		return exact.index;
	}
	const overlap = stacks.filter(s => s.trunk === trunk && s.branches.some(b => branches.includes(b.branch)));
	if (overlap.length === 1) {
		return overlap[0].index;
	}
	throw new MetadataError(`could not find exactly one stack in the gh-stack file for ${trunk} ← ${branches.join(' ← ')}`, 'not-found');
}

export interface RewriteEntry {
	branch: string;
	base: string;
	head?: string;
}

/**
 * Returns a new catalog with one stack's branch list replaced. Existing branch
 * objects keep every key (pullRequest, unknown fields); only order, base, and
 * head (when the entry already stored one) change. Removed branches are dropped
 * from tracking. Everything outside that stack is carried through untouched.
 */
export function rewriteStack(catalog: JsonObject, stackIndex: number, entries: RewriteEntry[]): JsonObject {
	const stacks = catalog.stacks as Json[];
	const target = asObject(stacks[stackIndex]);
	if (!target || !Array.isArray(target.branches)) {
		throw new MetadataError(`stack #${stackIndex} is missing from the gh-stack file`, 'not-found');
	}
	const existing = new Map<string, JsonObject>();
	for (const b of target.branches) {
		const bo = asObject(b);
		if (bo && typeof bo.branch === 'string') {
			existing.set(bo.branch, bo);
		}
	}
	const branches: Json[] = entries.map(e => {
		const prev = existing.get(e.branch);
		const next: JsonObject = prev ? { ...prev } : { branch: e.branch };
		next.base = e.base;
		if (prev && 'head' in prev && e.head) {
			next.head = e.head;
		}
		return next;
	});
	const nextStacks = stacks.slice();
	nextStacks[stackIndex] = { ...target, branches };
	return { ...catalog, stacks: nextStacks };
}

/** Same layout gh-stack writes (Go json.MarshalIndent, two spaces, no trailing newline). */
export function serializeCatalog(catalog: JsonObject): string {
	return JSON.stringify(catalog, null, 2);
}

// ---------------------------------------------------------------------------
// Locked writes. gh-stack serializes catalog writers with flock(2) on
// gh-stack-operation.lock then gh-stack.lock in the common dir, and compares a
// checksum before saving. Node has no flock, so a short perl helper holds both
// locks for the read-compare-write window.

const LOCKED_WRITE = String.raw`
use strict; use warnings;
use Fcntl qw(:flock O_RDWR O_CREAT);
use Digest::SHA qw(sha256_hex);
use File::Temp qw(tempfile);
my ($dir, $expect, $mode) = @ARGV;
sub take { my $p = shift; sysopen(my $fh, $p, O_RDWR|O_CREAT, 0644) or die "open $p: $!\n";
  my $deadline = time + 5;
  until (flock($fh, LOCK_EX|LOCK_NB)) { if (time > $deadline) { print STDERR "timed out waiting for $p\n"; exit 8 } select(undef, undef, undef, 0.1) }
  return $fh }
my $op = take("$dir/gh-stack-operation.lock");
my $cat = take("$dir/gh-stack.lock");
my $path = "$dir/gh-stack";
if ($expect ne '-') {
  my $cur = 'absent';
  if (-e $path) { open(my $r, '<:raw', $path) or die "read $path: $!\n"; local $/; my $d = <$r>; $cur = sha256_hex(defined $d ? $d : '') }
  if ($cur ne $expect) { print STDERR "gh-stack file changed on disk since it was read\n"; exit 9 }
}
if ($mode eq 'delete') { unlink $path if -e $path; exit 0 }
binmode STDIN; local $/; my $data = <STDIN>; $data = '' unless defined $data;
my $perm = (-e $path) ? ((stat $path)[2] & 07777) : 0644;
my ($fh, $tmp) = tempfile('.gh-stack-cairn-XXXXXX', DIR => $dir);
binmode $fh; print $fh $data or die "write: $!\n"; close $fh or die "close: $!\n";
chmod $perm, $tmp; rename($tmp, $path) or die "rename: $!\n";
exit 0;
`;

export interface WriteOptions {
	run: Run;
	commonDir: string;
	/** checksum the file must still have; '-' skips the comparison (restore) */
	expectedChecksum: string | '-';
	/** null deletes the file (restoring a stack that had no catalog) */
	data: Buffer | string | null;
}

export async function writeStackFileLocked(opts: WriteOptions): Promise<void> {
	const { run, commonDir, expectedChecksum, data } = opts;
	const mode = data === null ? 'delete' : 'write';
	let r;
	try {
		r = await run('perl', ['-e', LOCKED_WRITE, commonDir, expectedChecksum, mode], {
			cwd: commonDir,
			input: data === null ? '' : data.toString(),
			label: `${mode === 'delete' ? 'remove' : 'write'} ${stackFilePath(commonDir)} (holding gh-stack locks)`,
		});
	} catch {
		await writeUnlocked(commonDir, expectedChecksum, data);
		return;
	}
	if (r.code === 8) {
		throw new MetadataError('the gh-stack file is locked by another gh stack process; try again in a few seconds', 'locked');
	}
	if (r.code === 9) {
		throw new MetadataError('the gh-stack file changed while the plan ran; nothing was written', 'stale');
	}
	if (r.code !== 0) {
		throw new MetadataError(`writing the gh-stack file failed: ${r.stderr.trim()}`, 'io');
	}
}

/** Fallback when perl is unavailable (Windows): same checksum guard, atomic rename, no flock. */
async function writeUnlocked(commonDir: string, expectedChecksum: string, data: Buffer | string | null): Promise<void> {
	const p = stackFilePath(commonDir);
	if (expectedChecksum !== '-') {
		const now = await snapshotStackFile(commonDir);
		if (now.checksum !== expectedChecksum) {
			throw new MetadataError('the gh-stack file changed while the plan ran; nothing was written', 'stale');
		}
	}
	if (data === null) {
		await fs.rm(p, { force: true });
		return;
	}
	const tmp = path.join(commonDir, `.gh-stack-cairn-${process.pid}-${Date.now()}`);
	await fs.writeFile(tmp, data);
	await fs.rename(tmp, p);
}
