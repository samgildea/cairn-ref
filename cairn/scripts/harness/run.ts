// Runs the real StackController against a real repo and real gh stack, with a
// stubbed vscode API and a fake webview. Used to check host behavior without an
// Extension Development Host.
//
//   node .harness/run.js <repo> [--order a,b,c] [--apply] [--undo] [--state out.json] [--checkout b]

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { StackController } from '../../src/controller';
import type { Run, RunResult } from '../../src/run';
import type { ToWebview, ViewState } from '../../src/protocol';
import * as vscode from './vscode-stub';

const argv = process.argv.slice(2);
const repo = argv[0];
const flag = (name: string) => argv.includes(name);
const opt = (name: string) => {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : undefined;
};

const log: string[] = [];
const run: Run = (cmd, args, opts) =>
	new Promise<RunResult>((resolve, reject) => {
		const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1', ...opts.env }, stdio: ['pipe', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', d => (stdout += d));
		child.stderr.on('data', d => (stderr += d));
		child.on('error', reject);
		child.on('close', code => {
			const shown = opts.label ?? [cmd, ...args].join(' ');
			log.push(`$ ${shown}  → exit ${code}${stderr.trim() ? `\n    stderr: ${stderr.trim().split('\n').join('\n    stderr: ')}` : ''}`);
			resolve({ code: code ?? -1, stdout, stderr });
		});
		child.stdin.end(opts.input ?? '');
	});

async function main() {
	vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(repo), name: 'demo', index: 0 }];
	const ctx = {
		workspaceState: vscode.memento(),
		secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined },
		extensionUri: vscode.Uri.file(process.cwd()),
		subscriptions: [],
	};
	const statusBar = { text: '', tooltip: '', show() {}, hide() {}, dispose() {} };
	const controller = new StackController(ctx as never, run, { line: t => log.push(t), show() {} }, statusBar as never);
	const web = vscode.fakeWebviewView();
	controller.resolveWebviewView(web.view as never);

	const waitFor = async <T extends ToWebview>(pred: (m: ToWebview) => m is T, from: number, ms = 30_000): Promise<T> => {
		const end = Date.now() + ms;
		while (Date.now() < end) {
			for (let i = from; i < web.posted.length; i++) {
				const m = web.posted[i] as ToWebview;
				if (pred(m)) {
					return m;
				}
			}
			await new Promise(r => setTimeout(r, 50));
		}
		throw new Error('timed out waiting for the host');
	};
	const isState = (status: ViewState['status'], extra?: (s: ViewState) => boolean) =>
		(m: ToWebview): m is Extract<ToWebview, { type: 'state' }> => m.type === 'state' && m.state.status === status && (!extra || extra(m.state));
	const settle = async () => {
		await new Promise(r => setTimeout(r, 600));
		const states = web.posted.filter((m): m is Extract<ToWebview, { type: 'state' }> => (m as ToWebview).type === 'state');
		return states[states.length - 1].state;
	};

	let mark = web.posted.length;
	web.send({ type: 'ready' });
	await waitFor(isState('ready'), mark).catch(async () => {
		console.log(JSON.stringify(await settle(), null, 2));
		process.exit(1);
	});
	let state = await settle();
	if (state.status !== 'ready') {
		console.log(JSON.stringify(state, null, 2));
		return;
	}
	const show = (s: ViewState) => {
		if (s.status !== 'ready') {
			console.log(`status: ${s.status}`);
			return;
		}
		const layers = s.stack.layers;
		console.log(`statusBar: ${statusBar.text}`);
		console.log(`op: ${JSON.stringify(s.op)}`);
		for (const l of [...layers].reverse()) {
			console.log(`  ${l.isCurrent ? '●' : l.isMerged ? '✓' : '○'} ${l.draft.title}  [${l.name}]  +${l.additions} −${l.deletions}  range=${l.rangeSource}:${l.rangeBase.slice(0, 7)}  commits=${l.commits.map(c => c.subject).join(' | ')}  files=${l.files.map(f => f.path).join(',')}`);
		}
		console.log(`  ▪ ${s.stack.trunk.name} (trunk) behind=${s.stack.trunk.track.behind}`);
		console.log(`  candidates: ${s.stack.candidates.map(c => `${c.name}(${c.commits})`).join(', ') || 'none'}`);
		console.log(`  dirty: ${JSON.stringify(s.stack.dirty)}  wrongLayer: ${JSON.stringify(s.stack.wrongLayer)}`);
	};
	console.log('--- initial state');
	show(state);
	const out = opt('--state');
	if (out) {
		writeFileSync(out, JSON.stringify(state, null, 2));
	}

	const checkout = opt('--checkout');
	if (checkout) {
		mark = web.posted.length;
		web.send({ type: 'checkout', branch: checkout });
		await waitFor(isState('ready', s => s.status === 'ready' && s.stack.currentBranch === checkout), mark);
		state = await settle();
		console.log(`--- after checkout ${checkout}`);
		show(state);
	}

	const order = opt('--order')?.split(',');
	if (order) {
		mark = web.posted.length;
		web.send({ type: 'previewPlan', order });
		const plan = await waitFor((m): m is Extract<ToWebview, { type: 'plan' }> => m.type === 'plan', mark);
		console.log('--- plan preview');
		console.log(JSON.stringify(plan.plan ?? plan.error, null, 2));

		if (flag('--apply')) {
			mark = web.posted.length;
			web.send({ type: 'applyPlan', order });
			await waitFor(isState('ready', s => s.status === 'ready' && s.op.kind !== 'idle' && s.op.kind !== 'running'), mark, 60_000);
			state = await settle();
			console.log('--- after apply');
			show(state);
		}
		if (flag('--undo')) {
			mark = web.posted.length;
			web.send({ type: 'undo' });
			await waitFor(isState('ready', s => s.status === 'ready' && s.op.kind === 'idle'), mark, 60_000);
			state = await settle();
			console.log('--- after undo');
			show(state);
		}
	}

	console.log('--- prompts the user would have seen');
	for (const p of vscode.prompts) {
		console.log(`[${p.kind}] ${p.message}${p.detail ? `\n    ${p.detail.split('\n').join('\n    ')}` : ''}`);
	}
	console.log('--- commands run');
	console.log(log.filter(l => l.startsWith('$ gh') || l.startsWith('$ git rebase') || l.startsWith('$ write') || l.startsWith('$ remove') || l.includes('checkout') || l.includes('update-ref')).join('\n'));
	controller.dispose();
	process.exit(0);
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
