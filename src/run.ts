export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface RunOptions {
	cwd: string;
	/** written to stdin, then stdin is closed */
	input?: string;
	env?: Record<string, string>;
	/** shown in the output channel instead of the argv, for helpers whose argv is noise */
	label?: string;
	/** routine read: log one line instead of the full block */
	quiet?: boolean;
}

/**
 * Spawns a process without a shell and without a TTY. Never rejects for a
 * non-zero exit; callers branch on `code`. Rejects only when the binary could
 * not be started (code is then -1 in the log).
 */
export type Run = (cmd: string, args: string[], opts: RunOptions) => Promise<RunResult>;

export class SpawnError extends Error {
	constructor(readonly cmd: string, readonly cause: unknown) {
		super(`could not start ${cmd}: ${cause instanceof Error ? cause.message : String(cause)}`);
	}
}
