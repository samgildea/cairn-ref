// Pure: current stack + proposed order -> rebase commands. No git, no I/O.

export const TRUNK = Symbol('trunk');
type Parent = string | typeof TRUNK;

export interface PlanBranch {
	name: string;
	head: string;
	/** the recorded base SHA: the parent commit this branch's own commits sit on */
	base: string;
	isMerged?: boolean;
}

export interface PlanInput {
	trunk: {
		name: string;
		/** the trunk commit the stack sits on today; a branch moved to the bottom is replayed onto it */
		tip: string;
	};
	/** bottom (next to trunk) first */
	current: PlanBranch[];
	/** local branches not in the stack that the proposal may insert; base is their fork point */
	candidates?: PlanBranch[];
	/** bottom first */
	proposed: string[];
}

export interface RebaseStep {
	kind: 'rebase';
	branch: string;
	/** a branch name (resolved when the step runs, after earlier steps moved it) or a SHA */
	onto: string;
	ontoLabel: string;
	/** always a SHA: the branch's recorded base */
	upstream: string;
	argv: string[];
}

export type BaseSpec =
	| { kind: 'keep'; sha: string }
	/** the parent's tip after the plan ran; TRUNK resolves to trunk.tip */
	| { kind: 'parent-tip'; parent: string | null };

export interface MetadataStep {
	kind: 'metadata';
	order: Array<{ branch: string; base: BaseSpec }>;
	added: string[];
	removed: string[];
}

export interface Plan {
	steps: RebaseStep[];
	metadata: MetadataStep;
	moved: string[];
	added: string[];
	removed: string[];
	noop: boolean;
}

export class PlanError extends Error {}

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

function requireSha(value: string, what: string): void {
	if (!SHA.test(value)) {
		throw new PlanError(`${what} must be a full commit SHA, got "${value}"`);
	}
}

export function computePlan(input: PlanInput): Plan {
	const { trunk, current, proposed } = input;
	const candidates = input.candidates ?? [];
	requireSha(trunk.tip, `trunk tip of ${trunk.name}`);

	const byName = new Map<string, PlanBranch>();
	for (const b of [...current, ...candidates]) {
		if (byName.has(b.name) && !current.includes(b)) {
			continue;
		}
		byName.set(b.name, b);
	}

	const merged = current.filter(b => b.isMerged).map(b => b.name);
	if (merged.length > 0) {
		throw new PlanError(`the stack has merged branches (${merged.join(', ')}); run gh stack sync before reordering`);
	}

	const seen = new Set<string>();
	for (const name of proposed) {
		if (name === trunk.name) {
			throw new PlanError(`${trunk.name} is the trunk and cannot be a layer`);
		}
		if (seen.has(name)) {
			throw new PlanError(`${name} appears twice in the proposed order`);
		}
		seen.add(name);
		const b = byName.get(name);
		if (!b) {
			throw new PlanError(`${name} is not a local branch known to this stack`);
		}
		requireSha(b.head, `head of ${name}`);
		requireSha(b.base, `recorded base of ${name}`);
	}

	const originalParent = new Map<string, Parent>();
	current.forEach((b, i) => originalParent.set(b.name, i === 0 ? TRUNK : current[i - 1].name));

	const tipBefore = (p: Parent): string => (p === TRUNK ? trunk.tip : byName.get(p)!.head);

	const steps: RebaseStep[] = [];
	const rewritten = new Set<string>();
	const order: MetadataStep['order'] = [];

	proposed.forEach((name, i) => {
		const b = byName.get(name)!;
		const parent: Parent = i === 0 ? TRUNK : proposed[i - 1];
		const parentChanged = originalParent.get(name) !== parent;
		const parentRewritten = parent !== TRUNK && rewritten.has(parent);
		const alreadyOnParent = b.base === tipBefore(parent);
		const needed = parentRewritten || (parentChanged && !alreadyOnParent);

		if (!needed) {
			order.push({ branch: name, base: { kind: 'keep', sha: b.base } });
			return;
		}
		const onto = parent === TRUNK ? trunk.tip : parent;
		const ontoLabel = parent === TRUNK ? `${trunk.name} @ ${trunk.tip.slice(0, 7)}` : parent;
		steps.push({
			kind: 'rebase',
			branch: name,
			onto,
			ontoLabel,
			upstream: b.base,
			argv: ['rebase', '--onto', onto, b.base, name],
		});
		rewritten.add(name);
		order.push({ branch: name, base: { kind: 'parent-tip', parent: parent === TRUNK ? null : parent } });
	});

	const currentNames = current.map(b => b.name);
	const added = proposed.filter(n => !originalParent.has(n));
	const removed = currentNames.filter(n => !seen.has(n));
	const keptCurrent = currentNames.filter(n => seen.has(n));
	const keptProposed = proposed.filter(n => originalParent.has(n));
	const moved = keptProposed.filter((n, i) => keptCurrent[i] !== n);

	const noop = steps.length === 0 && added.length === 0 && removed.length === 0 && moved.length === 0;

	return {
		steps,
		metadata: { kind: 'metadata', order, added, removed },
		moved,
		added,
		removed,
		noop,
	};
}

/** The plan as the shell commands the user will see before anything runs. */
export function describePlan(plan: Plan, stackFilePath: string): Array<{ kind: 'rebase' | 'metadata'; command: string; detail: string; branch?: string }> {
	const lines: Array<{ kind: 'rebase' | 'metadata'; command: string; detail: string; branch?: string }> = plan.steps.map(s => ({
		kind: 'rebase',
		branch: s.branch,
		command: `git ${s.argv.join(' ')}`,
		detail: `replay ${s.branch}'s own commits (after ${s.upstream.slice(0, 7)}) onto ${s.ontoLabel}`,
	}));
	if (!plan.noop) {
		const chain = plan.metadata.order.map(o => o.branch).join(' ← ');
		const extra = [
			plan.metadata.added.length ? `adds ${plan.metadata.added.join(', ')}` : '',
			plan.metadata.removed.length ? `drops ${plan.metadata.removed.join(', ')} from tracking (branch kept)` : '',
		].filter(Boolean).join('; ');
		lines.push({
			kind: 'metadata',
			command: `write ${stackFilePath}`,
			detail: `store order ${chain} and each branch's new base SHA${extra ? `; ${extra}` : ''}`,
		});
	}
	return lines;
}
