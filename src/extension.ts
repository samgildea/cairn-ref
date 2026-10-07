import { spawn } from 'node:child_process';
import * as vscode from 'vscode';
import { StackController, type Logger } from './controller';
import { SpawnError, type Run, type RunResult } from './run';

const NON_INTERACTIVE_ENV = {
	GH_PROMPT_DISABLED: '1',
	GH_NO_UPDATE_NOTIFIER: '1',
	GH_SPINNER_DISABLED: '1',
	GH_PAGER: 'cat',
	GIT_PAGER: 'cat',
	PAGER: 'cat',
	GIT_TERMINAL_PROMPT: '0',
	NO_COLOR: '1',
	CLICOLOR: '0',
};

function quote(arg: string): string {
	return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

function clock(): string {
	return new Date().toTimeString().slice(0, 8);
}

/**
 * Every process the extension starts goes through here: no shell, pipes on all
 * three streams so gh never sees a TTY, prompts disabled, and one log entry with
 * the exit code and stderr.
 */
function createRunner(out: vscode.OutputChannel): Run {
	return (cmd, args, opts) =>
		new Promise<RunResult>((resolve, reject) => {
			const started = Date.now();
			const shown = opts.label ?? [cmd, ...args].map(quote).join(' ');
			const child = spawn(cmd, args, {
				cwd: opts.cwd,
				env: { ...process.env, ...NON_INTERACTIVE_ENV, ...opts.env },
				stdio: ['pipe', 'pipe', 'pipe'],
				shell: false,
				windowsHide: true,
			});
			let stdout = '';
			let stderr = '';
			child.stdout.setEncoding('utf8').on('data', d => (stdout += d));
			child.stderr.setEncoding('utf8').on('data', d => (stderr += d));
			child.on('error', e => {
				out.appendLine(`[${clock()}] $ ${shown}\n    could not start: ${e.message}`);
				reject(new SpawnError(cmd, e));
			});
			child.on('close', code => {
				const exit = code ?? -1;
				const ms = Date.now() - started;
				const err = stderr.trim();
				const compact = opts.quiet && cmd === 'git' && exit === 0 && !err;
				if (compact) {
					out.appendLine(`[${clock()}] $ ${shown}  → exit 0 (${ms}ms)`);
				} else {
					out.appendLine(`[${clock()}] $ ${shown}`);
					out.appendLine(`    cwd: ${opts.cwd}`);
					out.appendLine(`    exit ${exit} (${ms}ms)`);
					if (err) {
						out.appendLine(err.split('\n').map(l => `    stderr: ${l}`).join('\n'));
					}
				}
				resolve({ code: exit, stdout, stderr });
			});
			child.stdin.on('error', () => undefined);
			child.stdin.end(opts.input ?? '');
		});
}

export function activate(context: vscode.ExtensionContext): void {
	const out = vscode.window.createOutputChannel('Cairn');
	const log: Logger = { line: t => out.appendLine(`[${clock()}] ${t}`), show: () => out.show(true) };
	const run = createRunner(out);

	const statusBar = vscode.window.createStatusBarItem('cairn.position', vscode.StatusBarAlignment.Left, 90);
	statusBar.name = 'Cairn stack position';
	statusBar.command = 'cairn.checkout';

	const controller = new StackController(context, run, log, statusBar);

	context.subscriptions.push(
		out,
		statusBar,
		controller,
		vscode.window.registerWebviewViewProvider(StackController.viewId, controller),
	);

	const commands: Record<string, (...args: unknown[]) => unknown> = {
		'cairn.refresh': () => controller.schedule('full', 0),
		'cairn.fetch': () => controller.fetch(),
		'cairn.checkout': (branch?: unknown) => (typeof branch === 'string' ? controller.checkout(branch) : controller.pickCheckout()),
		'cairn.up': () => controller.navigate('up'),
		'cairn.down': () => controller.navigate('down'),
		'cairn.top': () => controller.navigate('top'),
		'cairn.bottom': () => controller.navigate('bottom'),
		'cairn.addBranch': () => controller.addBranch(),
		'cairn.newStack': () => controller.openBuilder(),
		'cairn.submit': () => controller.submit(false),
		'cairn.submitReady': () => controller.submit(true),
		'cairn.publish': () => controller.publish(),
		'cairn.undo': () => controller.undo(),
		'cairn.rebaseContinue': () => controller.continueRebase(),
		'cairn.rebaseAbort': () => controller.abortRebase(),
		'cairn.rebaseUpstack': () => controller.simple('rebaseUpstack'),
		'cairn.sync': () => controller.simple('sync'),
		'cairn.unstackLocal': () => controller.simple('unstackLocal'),
		'cairn.unstack': () => controller.simple('unstack'),
		'cairn.merge': () => controller.simple('merge'),
		'cairn.openWorktree': (branch?: unknown) => controller.openWorktree(typeof branch === 'string' ? branch : undefined),
		'cairn.installGhStack': () => controller.installGhStack(),
		'cairn.showOutput': () => out.show(true),
	};
	for (const [id, fn] of Object.entries(commands)) {
		context.subscriptions.push(vscode.commands.registerCommand(id, fn));
	}

	controller.schedule('network', 0);
}

export function deactivate(): void {}
