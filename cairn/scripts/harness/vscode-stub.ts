// Just enough of the vscode API to run StackController in plain Node for the
// harness. Modal confirmations auto-accept and are recorded so the harness can
// print exactly what the user would have been asked.

export const prompts: Array<{ kind: string; message: string; detail?: string }> = [];
export const opened: string[] = [];

class Emitter<T> {
	private listeners: Array<(e: T) => void> = [];
	event = (fn: (e: T) => void) => {
		this.listeners.push(fn);
		return { dispose: () => (this.listeners = this.listeners.filter(l => l !== fn)) };
	};
	fire(e: T) {
		this.listeners.forEach(l => l(e));
	}
}

export class Uri {
	constructor(readonly scheme: string, readonly fsPath: string) {}
	static file(p: string) {
		return new Uri('file', p);
	}
	static parse(s: string) {
		return new Uri('https', s);
	}
	static joinPath(u: Uri, ...parts: string[]) {
		return new Uri(u.scheme, [u.fsPath, ...parts].join('/'));
	}
	toString() {
		return `${this.scheme}://${this.fsPath}`;
	}
}

export class RelativePattern {
	constructor(readonly base: Uri, readonly pattern: string) {}
}

export enum StatusBarAlignment { Left = 1, Right = 2 }

const config: Record<string, unknown> = {};
const noop = { dispose() {} };

export const workspace = {
	workspaceFolders: [] as Array<{ uri: Uri; name: string; index: number }>,
	getConfiguration: () => ({ get: (k: string) => config[k] }),
	getWorkspaceFolder: () => undefined,
	createFileSystemWatcher: () => ({ onDidChange: () => noop, onDidCreate: () => noop, onDidDelete: () => noop, dispose() {} }),
	onDidChangeWorkspaceFolders: () => noop,
	onDidSaveTextDocument: () => noop,
	onDidChangeConfiguration: () => noop,
};

function record(kind: string) {
	return async (message: string, ...rest: unknown[]) => {
		const opts = rest.find(r => typeof r === 'object' && r !== null) as { modal?: boolean; detail?: string } | undefined;
		const actions = rest.filter(r => typeof r === 'string') as string[];
		prompts.push({ kind, message, detail: opts?.detail });
		return opts?.modal ? actions[0] : undefined;
	};
}

export const window = {
	activeTextEditor: undefined,
	onDidChangeWindowState: () => noop,
	showInformationMessage: record('info'),
	showWarningMessage: record('warning'),
	showErrorMessage: record('error'),
	showQuickPick: async () => undefined,
	showInputBox: async () => undefined,
	createQuickPick: () => {
		throw new Error('quick pick not available in the harness');
	},
};

export const authentication = {
	onDidChangeSessions: () => noop,
	getSession: async () => undefined,
};

export const commands = {
	executeCommand: async (id: string, ...args: unknown[]) => {
		opened.push(`${id} ${args.map(a => String(a)).join(' ')}`);
	},
};

export const env = {
	openExternal: async (u: Uri) => {
		opened.push(`openExternal ${u.fsPath}`);
		return true;
	},
};

export const extensions = { getExtension: () => undefined };

export function memento() {
	const store = new Map<string, unknown>();
	return {
		get: <T>(k: string, d?: T) => (store.has(k) ? (store.get(k) as T) : d),
		update: async (k: string, v: unknown) => {
			if (v === undefined) {
				store.delete(k);
			} else {
				store.set(k, v);
			}
		},
		keys: () => [...store.keys()],
	};
}

export function fakeWebviewView() {
	const fromWebview = new Emitter<unknown>();
	const posted: unknown[] = [];
	const view = {
		visible: true,
		webview: {
			options: {},
			html: '',
			cspSource: 'vscode-resource:',
			asWebviewUri: (u: Uri) => u,
			postMessage: async (m: unknown) => {
				posted.push(m);
				return true;
			},
			onDidReceiveMessage: (fn: (m: unknown) => void) => fromWebview.event(fn),
		},
		onDidChangeVisibility: () => noop,
	};
	return { view, posted, send: (m: unknown) => fromWebview.fire(m) };
}
