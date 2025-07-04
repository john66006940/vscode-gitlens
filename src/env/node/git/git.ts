import type { SpawnOptions } from 'child_process';
import { spawn } from 'child_process';
import { accessSync } from 'fs';
import { join as joinPath } from 'path';
import * as process from 'process';
import type { CancellationToken, Disposable, OutputChannel } from 'vscode';
import { env, Uri, window, workspace } from 'vscode';
import { hrtime } from '@env/hrtime';
import { GlyphChars } from '../../../constants';
import type { Container } from '../../../container';
import { CancellationError, isCancellationError } from '../../../errors';
import type { FilteredGitFeatures, GitFeatureOrPrefix, GitFeatures } from '../../../features';
import { gitFeaturesByVersion } from '../../../features';
import type { GitCommandOptions, GitSpawnOptions } from '../../../git/commandOptions';
import { GitErrorHandling } from '../../../git/commandOptions';
import {
	BlameIgnoreRevsFileBadRevisionError,
	BlameIgnoreRevsFileError,
	BranchError,
	BranchErrorReason,
	FetchError,
	FetchErrorReason,
	PullError,
	PullErrorReason,
	PushError,
	PushErrorReason,
	ResetError,
	ResetErrorReason,
	StashPushError,
	StashPushErrorReason,
	TagError,
	TagErrorReason,
	WorkspaceUntrustedError,
} from '../../../git/errors';
import type { GitDir } from '../../../git/gitProvider';
import type { GitDiffFilter } from '../../../git/models/diff';
import { parseGitRemoteUrl } from '../../../git/parsers/remoteParser';
import { isUncommitted, isUncommittedStaged, shortenRevision } from '../../../git/utils/revision.utils';
import { getCancellationTokenId } from '../../../system/-webview/cancellation';
import { configuration } from '../../../system/-webview/configuration';
import { splitPath } from '../../../system/-webview/path';
import { getHostEditorCommand } from '../../../system/-webview/vscode';
import { getScopedCounter } from '../../../system/counter';
import { log } from '../../../system/decorators/log';
import { Logger } from '../../../system/logger';
import { slowCallWarningThreshold } from '../../../system/logger.constants';
import { getLoggableScopeBlockOverride, getLogScope } from '../../../system/logger.scope';
import { dirname, isAbsolute, joinPaths, normalizePath } from '../../../system/path';
import { isPromise } from '../../../system/promise';
import { getDurationMilliseconds } from '../../../system/string';
import { compare, fromString } from '../../../system/version';
import { ensureGitTerminal } from '../../../terminal';
import type { GitLocation } from './locator';
import type { RunOptions, RunResult } from './shell';
import { fsExists, isWindows, runSpawn } from './shell';
import { CancelledRunError, RunError } from './shell.errors';

const emptyArray: readonly any[] = Object.freeze([]);
const emptyObj = Object.freeze({});

export const gitConfigsBranch = ['-c', 'color.branch=false'] as const;
export const gitConfigsDiff = ['-c', 'color.diff=false'] as const;
export const gitConfigsLog = ['-c', 'log.showSignature=false'] as const;
export const gitConfigsLogWithFiles = ['-c', 'log.showSignature=false', '-c', 'diff.renameLimit=0'] as const;
export const gitConfigsPull = ['-c', 'merge.autoStash=true', '-c', 'rebase.autoStash=true'] as const;
export const gitConfigsStatus = ['-c', 'color.status=false'] as const;

export const maxGitCliLength = 30000;

const textDecoder = new TextDecoder('utf8');

// This is a root sha of all git repo's if using sha1
const rootSha = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export const GitErrors = {
	alreadyCheckedOut: /already checked out/i,
	alreadyExists: /already exists/i,
	ambiguousArgument: /fatal:\s*ambiguous argument ['"].+['"]: unknown revision or path not in the working tree/i,
	badRevision: /bad revision '(.*?)'/i,
	branchAlreadyExists: /fatal: A branch named '.+?' already exists/i,
	branchNotFullyMerged: /error: The branch '.+?' is not fully merged/i,
	cantLockRef: /cannot lock ref|unable to update local ref/i,
	changesWouldBeOverwritten:
		/Your local changes to the following files would be overwritten|Your local changes would be overwritten/i,
	commitChangesFirst: /Please, commit your changes before you can/i,
	conflict: /^CONFLICT \([^)]+\): \b/m,
	detachedHead: /You are in 'detached HEAD' state/i,
	emptyPreviousCherryPick: /The previous cherry-pick is now empty/i,
	entryNotUpToDate: /error:\s*Entry ['"].+['"] not uptodate\. Cannot merge\./i,
	failedToDeleteDirectoryNotEmpty: /failed to delete '(.*?)': Directory not empty/i,
	invalidBranchName: /fatal: '.+?' is not a valid branch name/i,
	invalidLineCount: /file .+? has only (\d+) lines/i,
	invalidObjectName: /invalid object name: (.*)\s/i,
	invalidObjectNameList: /could not open object name list: (.*)\s/i,
	invalidTagName: /invalid tag name/i,
	mainWorkingTree: /is a main working tree/i,
	noFastForward: /\(non-fast-forward\)/i,
	noMergeBase: /no merge base/i,
	noRemoteReference: /unable to delete '.+?': remote ref does not exist/i,
	noRemoteRepositorySpecified: /No remote repository specified\./i,
	noUpstream: /^fatal: The current branch .* has no upstream branch/i,
	notAValidObjectName: /Not a valid object name/i,
	notAWorkingTree: /'(.*?)' is not a working tree/i,
	noUserNameConfigured: /Please tell me who you are\./i,
	noPausedOperation:
		/no merge (?:in progress|to abort)|no cherry-pick(?: or revert)? in progress|no rebase in progress/i,
	permissionDenied: /Permission.*denied/i,
	pushRejected: /^error: failed to push some refs to\b/m,
	rebaseMultipleBranches: /cannot rebase onto multiple branches/i,
	refLocked: /fatal:\s*cannot lock ref ['"].+['"]: unable to create file/i,
	remoteAhead: /rejected because the remote contains work/i,
	remoteConnection: /Could not read from remote repository/i,
	remoteRejected: /rejected because the remote contains work/i,
	tagAlreadyExists: /tag .* already exists/i,
	tagConflict: /! \[rejected\].*\(would clobber existing tag\)/m,
	tagNotFound: /tag .* not found/i,
	uncommittedChanges: /contains modified or untracked files/i,
	unmergedChanges: /error:\s*you need to resolve your current index first/i,
	unmergedFiles: /is not possible because you have unmerged files|You have unmerged files/i,
	unresolvedConflicts: /You must edit all merge conflicts|Resolve all conflicts/i,
	unstagedChanges: /You have unstaged changes/i,
};

const GitWarnings = {
	notARepository: /Not a git repository/i,
	outsideRepository: /is outside repository/i,
	noPath: /no such path/i,
	noCommits: /does not have any commits/i,
	notFound: /Path '.*?' does not exist in/i,
	foundButNotInRevision: /Path '.*?' exists on disk, but not in/i,
	headNotABranch: /HEAD does not point to a branch/i,
	noUpstream: /no upstream configured for branch '(.*?)'/i,
	unknownRevision:
		/ambiguous argument '.*?': unknown revision or path not in the working tree|not stored as a remote-tracking branch/i,
	mustRunInWorkTree: /this operation must be run in a work tree/i,
	patchWithConflicts: /Applied patch to '.*?' with conflicts/i,
	noRemoteRepositorySpecified: /No remote repository specified\./i,
	remoteConnectionError: /Could not read from remote repository/i,
	notAGitCommand: /'.+' is not a git command/i,
	tipBehind: /tip of your current branch is behind/i,
};

function defaultExceptionHandler(ex: Error, cwd: string | undefined, start?: [number, number]): void {
	if (isCancellationError(ex)) throw ex;

	const msg = ex.message || ex.toString();
	if (msg) {
		for (const warning of Object.values(GitWarnings)) {
			if (warning.test(msg)) {
				const duration = start !== undefined ? ` [${getDurationMilliseconds(start)}ms]` : '';
				Logger.warn(
					`[${cwd}] Git ${msg
						.trim()
						.replace(/fatal: /g, '')
						.replace(/\r?\n|\r/g, ` ${GlyphChars.Dot} `)}${duration}`,
				);
				return;
			}
		}

		const match = GitErrors.badRevision.exec(msg);
		if (match != null) {
			const [, ref] = match;

			// Since looking up a ref with ^3 (e.g. looking for untracked files in a stash) can error on some versions of git just ignore it
			if (ref?.endsWith('^3')) return;
		}
	}

	throw ex;
}

const uniqueCounterForStdin = getScopedCounter();

type ExitCodeOnlyGitCommandOptions = GitCommandOptions & { exitCodeOnly: true };
export type PushForceOptions = { withLease: true; ifIncludes?: boolean } | { withLease: false; ifIncludes?: never };

const branchErrorsToReasons: [RegExp, BranchErrorReason][] = [
	[GitErrors.noRemoteReference, BranchErrorReason.NoRemoteReference],
	[GitErrors.invalidBranchName, BranchErrorReason.InvalidBranchName],
	[GitErrors.branchAlreadyExists, BranchErrorReason.BranchAlreadyExists],
	[GitErrors.branchNotFullyMerged, BranchErrorReason.BranchNotFullyMerged],
];

const resetErrorsToReasons: [RegExp, ResetErrorReason][] = [
	[GitErrors.ambiguousArgument, ResetErrorReason.AmbiguousArgument],
	[GitErrors.changesWouldBeOverwritten, ResetErrorReason.ChangesWouldBeOverwritten],
	[GitErrors.detachedHead, ResetErrorReason.DetachedHead],
	[GitErrors.entryNotUpToDate, ResetErrorReason.EntryNotUpToDate],
	[GitErrors.permissionDenied, ResetErrorReason.PermissionDenied],
	[GitErrors.refLocked, ResetErrorReason.RefLocked],
	[GitErrors.unmergedChanges, ResetErrorReason.UnmergedChanges],
];

const tagErrorsToReasons: [RegExp, TagErrorReason][] = [
	[GitErrors.tagAlreadyExists, TagErrorReason.TagAlreadyExists],
	[GitErrors.tagNotFound, TagErrorReason.TagNotFound],
	[GitErrors.invalidTagName, TagErrorReason.InvalidTagName],
	[GitErrors.permissionDenied, TagErrorReason.PermissionDenied],
	[GitErrors.remoteRejected, TagErrorReason.RemoteRejected],
];

export class GitError extends Error {
	readonly cmd: string | undefined;
	readonly exitCode: number | string | undefined;
	readonly stdout: string | undefined;
	readonly stderr: string | undefined;

	constructor(readonly original: Error) {
		let message: string;
		let stdout: string | undefined;
		let stderr: string | undefined;
		let cmd: string | undefined;
		let exitCode: number | string | undefined;

		if (original instanceof RunError) {
			stdout = original.stdout;
			stderr = original.stderr;
			message = stderr || stdout || original.message;
			cmd = original.cmd;
			exitCode = original.code;
		} else {
			message = original.message;
		}

		super(message);

		this.stdout = stdout;
		this.stderr = stderr;
		this.cmd = cmd;
		this.exitCode = exitCode;

		Error.captureStackTrace?.(this, GitError);
	}
}

export type GitResult<T extends string | Buffer | unknown> = {
	readonly exitCode: number;
	readonly stdout: T;
	readonly stderr?: T;

	readonly cancelled?: boolean;
};

export class Git implements Disposable {
	private readonly _disposable: Disposable;
	/** Map of running git commands -- avoids running duplicate overlaping commands */
	private readonly pendingCommands = new Map<string, Promise<RunResult<string | Buffer>>>();

	constructor(container: Container) {
		this._disposable = container.events.on('git:cache:reset', e => {
			// Ignore provider resets (e.g. it needs to be git specific)
			if (e.data.types?.every(t => t === 'providers')) return;

			this.pendingCommands.clear();
		});
	}

	dispose(): void {
		this._disposable.dispose();
	}

	async exec(
		options: ExitCodeOnlyGitCommandOptions,
		...args: readonly (string | undefined)[]
	): Promise<GitResult<unknown>>;
	async exec<T extends string | Buffer = string>(
		options: GitCommandOptions,
		...args: readonly (string | undefined)[]
	): Promise<GitResult<T>>;
	async exec<T extends string | Buffer = string>(
		options: GitCommandOptions,
		...args: readonly (string | undefined)[]
	): Promise<GitResult<T | unknown>> {
		if (!workspace.isTrusted) throw new WorkspaceUntrustedError();

		const start = hrtime();

		const { cancellation, configs, correlationKey, errors: errorHandling, encoding, local, ...opts } = options;
		const runArgs = args.filter(a => a != null);

		const runOpts: Mutable<RunOptions> = {
			timeout: 1000 * 60,
			...opts,
			encoding: (encoding ?? 'utf8') === 'utf8' ? 'utf8' : 'buffer',
			// Adds GCM environment variables to avoid any possible credential issues -- from https://github.com/Microsoft/vscode/issues/26573#issuecomment-338686581
			// Shouldn't *really* be needed but better safe than sorry
			env: {
				...process.env,
				...this._gitEnv,
				...(options.env ?? emptyObj),
				GCM_INTERACTIVE: 'NEVER',
				GCM_PRESERVE_CREDS: 'TRUE',
				LC_ALL: 'C',
			},
		};

		const gitCommand = `[${runOpts.cwd}] git ${runArgs.join(' ')}`;

		const cacheKey = `${correlationKey !== undefined ? `${correlationKey}:` : ''}${
			options?.stdin != null ? `${uniqueCounterForStdin.next()}:` : ''
		}${cancellation != null ? `${getCancellationTokenId(cancellation)}:` : ''}${gitCommand}`;

		let waiting;
		let promise = this.pendingCommands.get(cacheKey);
		if (promise == null) {
			waiting = false;

			// Fixes https://github.com/gitkraken/vscode-gitlens/issues/73 & https://github.com/gitkraken/vscode-gitlens/issues/161
			// See https://stackoverflow.com/questions/4144417/how-to-handle-asian-characters-in-file-names-in-git-on-os-x
			runArgs.unshift(
				'-c',
				'core.quotepath=false',
				'-c',
				'color.ui=false',
				...(configs != null ? configs : emptyArray),
			);

			if (process.platform === 'win32') {
				runArgs.unshift('-c', 'core.longpaths=true');
			}

			let abortController: AbortController | undefined;
			let disposeCancellation: Disposable | undefined;
			if (cancellation != null) {
				abortController = new AbortController();
				runOpts.signal = abortController.signal;
				disposeCancellation = cancellation.onCancellationRequested(() => abortController?.abort());
			}

			promise = runSpawn<T>(await this.path(), runArgs, encoding ?? 'utf8', runOpts).finally(() => {
				this.pendingCommands.delete(cacheKey);
				void disposeCancellation?.dispose();
			});

			this.pendingCommands.set(cacheKey, promise);
		} else {
			waiting = true;
			Logger.debug(`${getLoggableScopeBlockOverride('GIT')} ${gitCommand} ${GlyphChars.Dot} waiting...`);
		}

		let exception: Error | undefined;
		let result;
		try {
			result = await promise;
			return {
				stdout: result.stdout as T,
				stderr: result.stderr as T | undefined,
				exitCode: result.exitCode ?? 0,
			};
		} catch (ex) {
			if (errorHandling === GitErrorHandling.Ignore) {
				if (ex instanceof RunError) {
					return {
						stdout: ex.stdout as T,
						stderr: ex.stderr as T | undefined,
						exitCode: ex.code != null ? (typeof ex.code === 'number' ? ex.code : parseInt(ex.code, 10)) : 0,
						cancelled: ex instanceof CancelledRunError,
					};
				}

				return {
					stdout: '' as T,
					stderr: undefined,
					exitCode: 0,
					cancelled: ex instanceof CancelledRunError,
				};
			}

			exception = ex instanceof CancelledRunError ? new CancellationError(ex) : new GitError(ex);
			if (errorHandling === GitErrorHandling.Throw) throw exception;

			defaultExceptionHandler(exception, options.cwd, start);
			exception = undefined;
			return { stdout: '' as T, stderr: result?.stderr as T | undefined, exitCode: result?.exitCode ?? 0 };
		} finally {
			this.logGitCommand(gitCommand, exception, getDurationMilliseconds(start), waiting);
		}
	}

	async *stream(options: GitSpawnOptions, ...args: readonly (string | undefined)[]): AsyncGenerator<string> {
		if (!workspace.isTrusted) throw new WorkspaceUntrustedError();

		const start = hrtime();

		const { cancellation, configs, stdin, stdinEncoding, ...opts } = options;
		const runArgs = args.filter(a => a != null);

		const spawnOpts: SpawnOptions = {
			// Unless provided, ignore stdin and leave default streams for stdout and stderr
			stdio: [stdin ? 'pipe' : 'ignore', null, null],
			...opts,
			// Adds GCM environment variables to avoid any possible credential issues -- from https://github.com/Microsoft/vscode/issues/26573#issuecomment-338686581
			// Shouldn't *really* be needed but better safe than sorry
			env: {
				...process.env,
				...this._gitEnv,
				...(options.env ?? emptyObj),
				GCM_INTERACTIVE: 'NEVER',
				GCM_PRESERVE_CREDS: 'TRUE',
				LC_ALL: 'C',
			},
		};

		const gitCommand = `(spawn) [${spawnOpts.cwd as string}] git ${runArgs.join(' ')}`;

		// Fixes https://github.com/gitkraken/vscode-gitlens/issues/73 & https://github.com/gitkraken/vscode-gitlens/issues/161
		// See https://stackoverflow.com/questions/4144417/how-to-handle-asian-characters-in-file-names-in-git-on-os-x
		runArgs.unshift(
			'-c',
			'core.quotepath=false',
			'-c',
			'color.ui=false',
			...(configs !== undefined ? configs : emptyArray),
		);

		if (process.platform === 'win32') {
			runArgs.unshift('-c', 'core.longpaths=true');
		}

		let disposable: Disposable | undefined;
		if (cancellation != null) {
			const aborter = new AbortController();
			const onAbort = () => aborter.abort();

			const signal = spawnOpts.signal;
			const cancellationDisposable = cancellation.onCancellationRequested(onAbort);

			disposable = {
				dispose: () => {
					cancellationDisposable.dispose();
					signal?.removeEventListener('abort', onAbort);
				},
			};

			spawnOpts.signal?.addEventListener('abort', onAbort);
			spawnOpts.signal = aborter.signal;
		}

		const command = await this.path();
		const proc = spawn(command, runArgs, spawnOpts);
		if (stdin) {
			proc.stdin?.end(stdin, (stdinEncoding ?? 'utf8') as BufferEncoding);
		}

		let exception: Error | undefined;

		const promise = new Promise<void>((resolve, reject) => {
			const stderrChunks: string[] = [];
			if (proc.stderr) {
				proc.stderr?.setEncoding('utf8');
				proc.stderr.on('data', chunk => stderrChunks.push(chunk));
			}

			proc.once('error', ex => {
				if (ex?.name === 'AbortError') return;

				exception = new GitError(ex);
			});
			proc.once('close', (code, signal) => {
				if (code === 0) {
					resolve();
					return;
				}

				if (signal === 'SIGTERM') {
					// If the caller aborted, just resolve
					if (spawnOpts.signal?.aborted) {
						resolve();
					} else {
						reject(
							new CancellationError(
								new CancelledRunError(proc.spawnargs.join(' '), true, code ?? undefined, signal),
							),
						);
					}
					return;
				}

				// If the caller didn't read the complete stream, just resolve
				if (
					signal === 'SIGPIPE' ||
					code === 141 /* SIGPIPE */ ||
					// Effectively SIGPIPE on WSL & Linux?
					(code === 128 && stderrChunks.some(c => c.includes('Connection reset by peer')))
				) {
					resolve();
					return;
				}

				const stderr = stderrChunks.join('').trim();
				reject(
					new GitError(
						new RunError(
							{
								message: `Error (${code}): ${stderr || 'Unknown'}`,
								cmd: proc.spawnargs.join(' '),
								killed: proc.killed,
								code: proc.exitCode,
							},
							'',
							stderr,
						),
					),
				);
			});
		});

		try {
			try {
				if (proc.stdout) {
					proc.stdout.setEncoding('utf8');
					for await (const chunk of proc.stdout) {
						yield chunk;
					}
				}
			} finally {
				// I have NO idea why this HAS to be in a finally block, but it does
				await promise;
			}
		} catch (ex) {
			exception = ex;
			throw ex;
		} finally {
			disposable?.dispose();
			proc.removeAllListeners();

			this.logGitCommand(gitCommand, exception, getDurationMilliseconds(start), false);
		}
	}

	private _gitLocation: GitLocation | undefined;
	private _gitLocationPromise: Promise<GitLocation> | undefined;
	private async getLocation(): Promise<GitLocation> {
		if (this._gitLocation == null) {
			if (this._gitLocationPromise == null) {
				this._gitLocationPromise = this._gitLocator();
			}
			this._gitLocation = await this._gitLocationPromise;
		}
		return this._gitLocation;
	}

	private _gitLocator!: () => Promise<GitLocation>;
	setLocator(locator: () => Promise<GitLocation>): void {
		this._gitLocator = locator;
		this._gitLocationPromise = undefined;
		this._gitLocation = undefined;
	}

	private _gitEnv: Record<string, unknown> | undefined;
	setEnv(env: Record<string, unknown> | undefined): void {
		this._gitEnv = env;
	}

	async path(): Promise<string> {
		return (await this.getLocation()).path;
	}

	async ensureSupports(feature: GitFeatures, prefix: string, suffix: string): Promise<void> {
		const version = gitFeaturesByVersion.get(feature);
		if (version == null) return;

		const gitVersion = await this.version();
		if (compare(fromString(gitVersion), fromString(version)) !== -1) return;

		throw new Error(
			`${prefix} requires a newer version of Git (>= ${version}) than is currently installed (${gitVersion}).${suffix}`,
		);
	}

	supports(feature: GitFeatures): boolean | Promise<boolean> {
		const version = gitFeaturesByVersion.get(feature);
		if (version == null) return true;

		return this._gitLocation != null
			? compare(fromString(this._gitLocation.version), fromString(version)) !== -1
			: this.version().then(v => compare(fromString(v), fromString(version)) !== -1);
	}

	supported<T extends GitFeatureOrPrefix>(feature: T): FilteredGitFeatures<T>[] | Promise<FilteredGitFeatures<T>[]> {
		function supportedCore(gitVersion: string): FilteredGitFeatures<T>[] {
			return [...gitFeaturesByVersion]
				.filter(([f, v]) => f.startsWith(feature) && compare(fromString(gitVersion), v) !== -1)
				.map(([f]) => f as FilteredGitFeatures<T>);
		}

		if (this._gitLocation == null) {
			return this.version().then(v => supportedCore(v));
		}
		return supportedCore(this._gitLocation.version);
	}

	async version(): Promise<string> {
		return (await this.getLocation()).version;
	}

	// Git commands

	private readonly ignoreRevsFileMap = new Map<string, boolean>();

	async blame(
		repoPath: string | undefined,
		fileName: string,
		options?: ({ ref: string | undefined; contents?: never } | { contents: string; ref?: never }) & {
			args?: string[] | null;
			correlationKey?: string;
			ignoreWhitespace?: boolean;
			startLine?: number;
			endLine?: number;
		},
	): Promise<GitResult<string>> {
		const [file, root] = splitPath(fileName, repoPath, true);

		const params = ['blame', '--root', '--incremental'];

		if (options?.ignoreWhitespace) {
			params.push('-w');
		}
		if (options?.startLine != null && options.endLine != null) {
			params.push(`-L ${options.startLine},${options.endLine}`);
		}
		if (options?.args != null) {
			// See if the args contains a value like: `--ignore-revs-file <file>` or `--ignore-revs-file=<file>` to account for user error
			// If so split it up into two args
			const argIndex = options.args.findIndex(
				arg => arg !== '--ignore-revs-file' && arg.startsWith('--ignore-revs-file'),
			);
			if (argIndex !== -1) {
				const match = /^--ignore-revs-file\s*=?\s*(.*)$/.exec(options.args[argIndex]);
				if (match != null) {
					options.args.splice(argIndex, 1, '--ignore-revs-file', match[1]);
				}
			}

			params.push(...options.args);
		}

		// Ensure the version of Git supports the --ignore-revs-file flag, otherwise the blame will fail
		const supportsIgnoreRevsFileResult = this.supports('git:ignoreRevsFile');
		let supportsIgnoreRevsFile = isPromise(supportsIgnoreRevsFileResult)
			? await supportsIgnoreRevsFileResult
			: supportsIgnoreRevsFileResult;

		const ignoreRevsIndex = params.indexOf('--ignore-revs-file');

		if (supportsIgnoreRevsFile) {
			let ignoreRevsFile;
			if (ignoreRevsIndex !== -1) {
				ignoreRevsFile = params[ignoreRevsIndex + 1];
				if (!isAbsolute(ignoreRevsFile)) {
					ignoreRevsFile = joinPaths(root, ignoreRevsFile);
				}
			} else {
				ignoreRevsFile = joinPaths(root, '.git-blame-ignore-revs');
			}

			const exists = this.ignoreRevsFileMap.get(ignoreRevsFile);
			if (exists !== undefined) {
				supportsIgnoreRevsFile = exists;
			} else {
				// Ensure the specified --ignore-revs-file exists, otherwise the blame will fail
				try {
					supportsIgnoreRevsFile = await fsExists(ignoreRevsFile);
				} catch {
					supportsIgnoreRevsFile = false;
				}

				this.ignoreRevsFileMap.set(ignoreRevsFile, supportsIgnoreRevsFile);
			}
		}

		if (!supportsIgnoreRevsFile && ignoreRevsIndex !== -1) {
			params.splice(ignoreRevsIndex, 2);
		} else if (supportsIgnoreRevsFile && ignoreRevsIndex === -1) {
			params.push('--ignore-revs-file', '.git-blame-ignore-revs');
		}

		let stdin;
		if (options?.contents != null) {
			// Pipe the blame contents to stdin
			params.push('--contents', '-');

			stdin = options.contents;
		} else if (options?.ref) {
			if (isUncommittedStaged(options.ref)) {
				// Pipe the blame contents to stdin
				params.push('--contents', '-');

				// Get the file contents for the staged version using `:`
				stdin = await this.show__content<string>(repoPath, fileName, ':');
			} else {
				params.push(options.ref);
			}
		}

		try {
			const result = await this.exec(
				{ cwd: root, stdin: stdin, correlationKey: options?.correlationKey },
				...params,
				'--',
				file,
			);
			return result;
		} catch (ex) {
			// Since `-c blame.ignoreRevsFile=` doesn't seem to work (unlike as the docs suggest), try to detect the error and throw a more helpful one
			let match = GitErrors.invalidObjectNameList.exec(ex.message);
			if (match != null) {
				throw new BlameIgnoreRevsFileError(match[1], ex);
			}

			match = GitErrors.invalidObjectName.exec(ex.message);
			if (match != null) {
				throw new BlameIgnoreRevsFileBadRevisionError(match[1], ex);
			}

			throw ex;
		}
	}

	async branch(repoPath: string, ...args: string[]): Promise<GitResult<string>> {
		try {
			const result = await this.exec({ cwd: repoPath }, 'branch', ...args);
			return result;
		} catch (ex) {
			const msg: string = ex?.toString() ?? '';
			for (const [error, reason] of branchErrorsToReasons) {
				if (error.test(msg) || error.test(ex.stderr ?? '')) {
					throw new BranchError(reason, ex);
				}
			}
			throw new BranchError(BranchErrorReason.Other, ex);
		}
	}

	async branchOrTag__containsOrPointsAt(
		repoPath: string,
		refs: string[],
		options?: {
			type?: 'branch' | 'tag';
			all?: boolean;
			mode?: 'contains' | 'pointsAt';
			name?: string;
			remotes?: boolean;
		},
		cancellation?: CancellationToken,
	): Promise<GitResult<string>> {
		const params: string[] = [options?.type ?? 'branch'];
		if (options?.all) {
			params.push('-a');
		} else if (options?.remotes) {
			params.push('-r');
		}

		params.push('--format=%(refname:short)');

		for (const ref of refs) {
			params.push(options?.mode === 'pointsAt' ? `--points-at=${ref}` : `--contains=${ref}`);
		}

		if (options?.name != null) {
			params.push(options.name);
		}

		const result = await this.exec(
			{
				cwd: repoPath,
				cancellation: cancellation,
				configs: gitConfigsBranch,
				errors: GitErrorHandling.Ignore,
			},
			...params,
		);
		return result;
	}

	async checkout(
		repoPath: string,
		ref: string,
		{ createBranch, path }: { createBranch?: string; path?: string } = {},
	): Promise<GitResult<string>> {
		const params = ['checkout'];
		if (createBranch) {
			params.push('-b', createBranch, ref, '--');
		} else {
			params.push(ref, '--');

			if (path) {
				[path, repoPath] = splitPath(path, repoPath, true);

				params.push(path);
			}
		}

		const result = await this.exec({ cwd: repoPath }, ...params);
		return result;
	}

	// TODO: Expand to include options and other params
	async clone(url: string, parentPath: string): Promise<string | undefined> {
		let count = 0;
		const [, , remotePath] = parseGitRemoteUrl(url);
		const remoteName = remotePath.split('/').pop();
		if (!remoteName) return undefined;

		let folderPath = joinPath(parentPath, remoteName);
		while ((await fsExists(folderPath)) && count < 20) {
			count++;
			folderPath = joinPath(parentPath, `${remotePath}-${count}`);
		}

		await this.exec({ cwd: parentPath }, 'clone', url, folderPath);

		return folderPath;
	}

	async config__get(key: string, repoPath?: string, options?: { local?: boolean }): Promise<string | undefined> {
		const result = await this.exec(
			{ cwd: repoPath ?? '', errors: GitErrorHandling.Ignore, local: options?.local },
			'config',
			'--get',
			key,
		);
		return result.stdout.trim() || undefined;
	}

	async config__get_regex(
		pattern: string,
		repoPath?: string,
		options?: { local?: boolean },
	): Promise<string | undefined> {
		const result = await this.exec(
			{ cwd: repoPath ?? '', errors: GitErrorHandling.Ignore, local: options?.local },
			'config',
			'--get-regex',
			pattern,
		);
		return result.stdout.trim() || undefined;
	}

	async diff(
		repoPath: string,
		fileName: string,
		ref1?: string,
		ref2?: string,
		options?: {
			encoding?: string;
			filters?: GitDiffFilter[];
			linesOfContext?: number;
			renames?: boolean;
			similarityThreshold?: number | null;
		},
	): Promise<GitResult<string>> {
		const params = ['diff', '--no-ext-diff', '--minimal'];

		if (options?.linesOfContext != null) {
			params.push(`-U${options.linesOfContext}`);
		}

		if (options?.renames) {
			params.push(`-M${options.similarityThreshold == null ? '' : `${options.similarityThreshold}%`}`);
		}

		if (options?.filters != null && options.filters.length !== 0) {
			params.push(`--diff-filter=${options.filters.join('')}`);
		}

		if (ref1) {
			// <sha>^3 signals an untracked file in a stash and if we are trying to find its parent, use the root sha
			if (ref1.endsWith('^3^')) {
				ref1 = rootSha;
			}
			params.push(isUncommittedStaged(ref1) ? '--staged' : ref1);
		}
		if (ref2) {
			params.push(isUncommittedStaged(ref2) ? '--staged' : ref2);
		}

		try {
			const result = await this.exec(
				{ cwd: repoPath, configs: gitConfigsDiff, encoding: options?.encoding },
				...params,
				'--',
				fileName,
			);
			return result;
		} catch (ex) {
			const match = GitErrors.badRevision.exec(ex.message);
			if (match !== null) {
				const [, ref] = match;

				// If the bad ref is trying to find a parent ref, assume we hit to the last commit, so try again using the root sha
				if (ref === ref1 && ref?.endsWith('^')) {
					return this.diff(repoPath, fileName, rootSha, ref2, options);
				}
			}

			throw ex;
		}
	}

	async diff__contents(
		repoPath: string,
		fileName: string,
		ref: string,
		contents: string,
		options?: { encoding?: string; filters?: GitDiffFilter[]; similarityThreshold?: number | null },
	): Promise<string> {
		const params = [
			'diff',
			`-M${options?.similarityThreshold == null ? '' : `${options.similarityThreshold}%`}`,
			'--no-ext-diff',
			'-U0',
			'--minimal',
		];

		if (options?.filters != null && options.filters.length !== 0) {
			params.push(`--diff-filter=${options.filters.join('')}`);
		}

		// // <sha>^3 signals an untracked file in a stash and if we are trying to find its parent, use the root sha
		// if (ref.endsWith('^3^')) {
		// 	ref = rootSha;
		// }
		// params.push(isUncommittedStaged(ref) ? '--staged' : ref);

		params.push('--no-index');

		try {
			const result = await this.exec(
				{
					cwd: repoPath,
					configs: gitConfigsDiff,
					encoding: options?.encoding,
					stdin: contents,
				},
				...params,
				'--',
				fileName,
				// Pipe the contents to stdin
				'-',
			);
			return result.stdout;
		} catch (ex) {
			if (ex instanceof GitError && ex.stdout) {
				return ex.stdout;
			}

			const match = GitErrors.badRevision.exec(ex.message);
			if (match !== null) {
				const [, matchedRef] = match;

				// If the bad ref is trying to find a parent ref, assume we hit to the last commit, so try again using the root sha
				if (matchedRef === ref && matchedRef?.endsWith('^')) {
					return this.diff__contents(repoPath, fileName, rootSha, contents, options);
				}
			}

			throw ex;
		}
	}

	async fetch(
		repoPath: string,
		options:
			| { all?: boolean; branch?: undefined; prune?: boolean; pull?: boolean; remote?: string }
			| {
					all?: undefined;
					branch: string;
					prune?: undefined;
					pull?: boolean;
					remote: string;
					upstream: string;
			  },
	): Promise<void> {
		const params = ['fetch'];

		if (options.prune) {
			params.push('--prune');
		}

		if (options.branch && options.remote) {
			if (options.upstream && options.pull) {
				params.push('-u', options.remote, `${options.upstream}:${options.branch}`);
			} else {
				params.push(options.remote, options.upstream || options.branch);
			}
		} else if (options.remote) {
			params.push(options.remote);
		} else if (options.all) {
			params.push('--all');
		}

		try {
			void (await this.exec({ cwd: repoPath }, ...params));
		} catch (ex) {
			const msg: string = ex?.toString() ?? '';
			let reason: FetchErrorReason = FetchErrorReason.Other;
			if (GitErrors.noFastForward.test(msg) || GitErrors.noFastForward.test(ex.stderr ?? '')) {
				reason = FetchErrorReason.NoFastForward;
			} else if (
				GitErrors.noRemoteRepositorySpecified.test(msg) ||
				GitErrors.noRemoteRepositorySpecified.test(ex.stderr ?? '')
			) {
				reason = FetchErrorReason.NoRemote;
			} else if (GitErrors.remoteConnection.test(msg) || GitErrors.remoteConnection.test(ex.stderr ?? '')) {
				reason = FetchErrorReason.RemoteConnection;
			}

			throw new FetchError(reason, ex, options?.branch, options?.remote);
		}
	}

	async push(
		repoPath: string,
		options: {
			branch?: string;
			force?: PushForceOptions;
			publish?: boolean;
			remote?: string;
			upstream?: string;
			delete?: {
				remote: string;
				branch: string;
			};
		},
	): Promise<void> {
		const params = ['push'];

		if (options.force != null) {
			if (options.force.withLease) {
				params.push('--force-with-lease');
				if (options.force.ifIncludes) {
					if (await this.supports('git:push:force-if-includes')) {
						params.push('--force-if-includes');
					}
				}
			} else {
				params.push('--force');
			}
		}

		if (options.branch && options.remote) {
			if (options.upstream) {
				params.push('-u', options.remote, `${options.branch}:${options.upstream}`);
			} else if (options.publish) {
				params.push('--set-upstream', options.remote, options.branch);
			} else {
				params.push(options.remote, options.branch);
			}
		} else if (options.remote) {
			params.push(options.remote);
		} else if (options.delete) {
			params.push(options.delete.remote, `:${options.delete.branch}`);
		}

		try {
			void (await this.exec({ cwd: repoPath }, ...params));
		} catch (ex) {
			const msg: string = ex?.toString() ?? '';
			let reason: PushErrorReason = PushErrorReason.Other;
			if (GitErrors.remoteAhead.test(msg) || GitErrors.remoteAhead.test(ex.stderr ?? '')) {
				reason = PushErrorReason.RemoteAhead;
			} else if (GitWarnings.tipBehind.test(msg) || GitWarnings.tipBehind.test(ex.stderr ?? '')) {
				reason = PushErrorReason.TipBehind;
			} else if (GitErrors.pushRejected.test(msg) || GitErrors.pushRejected.test(ex.stderr ?? '')) {
				if (options?.force?.withLease) {
					if (/! \[rejected\].*\(stale info\)/m.test(ex.stderr || '')) {
						reason = PushErrorReason.PushRejectedWithLease;
					} else if (
						options.force.ifIncludes &&
						/! \[rejected\].*\(remote ref updated since checkout\)/m.test(ex.stderr || '')
					) {
						reason = PushErrorReason.PushRejectedWithLeaseIfIncludes;
					} else if (/error: unable to delete '(.*?)': remote ref does not exist/m.test(ex.stderr || '')) {
						reason = PushErrorReason.PushRejectedRefNotExists;
					} else {
						reason = PushErrorReason.PushRejected;
					}
				} else {
					reason = PushErrorReason.PushRejected;
				}
			} else if (/error: unable to delete '(.*?)': remote ref does not exist/m.test(ex.stderr || '')) {
				reason = PushErrorReason.PushRejectedRefNotExists;
			} else if (GitErrors.permissionDenied.test(msg) || GitErrors.permissionDenied.test(ex.stderr ?? '')) {
				reason = PushErrorReason.PermissionDenied;
			} else if (GitErrors.remoteConnection.test(msg) || GitErrors.remoteConnection.test(ex.stderr ?? '')) {
				reason = PushErrorReason.RemoteConnection;
			} else if (GitErrors.noUpstream.test(msg) || GitErrors.noUpstream.test(ex.stderr ?? '')) {
				reason = PushErrorReason.NoUpstream;
			}

			throw new PushError(
				reason,
				ex,
				options?.branch || options?.delete?.branch,
				options?.remote || options?.delete?.remote,
			);
		}
	}

	async pull(repoPath: string, options: { rebase?: boolean; tags?: boolean }): Promise<void> {
		const params = ['pull'];

		if (options.tags) {
			params.push('--tags');
		}

		if (options.rebase) {
			params.push('-r');
		}

		try {
			void (await this.exec({ cwd: repoPath, configs: gitConfigsPull }, ...params));
		} catch (ex) {
			const msg: string = ex?.toString() ?? '';
			let reason: PullErrorReason = PullErrorReason.Other;
			if (GitErrors.conflict.test(msg) || GitErrors.conflict.test(ex.stdout ?? '')) {
				reason = PullErrorReason.Conflict;
			} else if (
				GitErrors.noUserNameConfigured.test(msg) ||
				GitErrors.noUserNameConfigured.test(ex.stderr ?? '')
			) {
				reason = PullErrorReason.GitIdentity;
			} else if (GitErrors.remoteConnection.test(msg) || GitErrors.remoteConnection.test(ex.stderr ?? '')) {
				reason = PullErrorReason.RemoteConnection;
			} else if (GitErrors.unstagedChanges.test(msg) || GitErrors.unstagedChanges.test(ex.stderr ?? '')) {
				reason = PullErrorReason.UnstagedChanges;
			} else if (GitErrors.unmergedFiles.test(msg) || GitErrors.unmergedFiles.test(ex.stderr ?? '')) {
				reason = PullErrorReason.UnmergedFiles;
			} else if (GitErrors.commitChangesFirst.test(msg) || GitErrors.commitChangesFirst.test(ex.stderr ?? '')) {
				reason = PullErrorReason.UncommittedChanges;
			} else if (
				GitErrors.changesWouldBeOverwritten.test(msg) ||
				GitErrors.changesWouldBeOverwritten.test(ex.stderr ?? '')
			) {
				reason = PullErrorReason.OverwrittenChanges;
			} else if (GitErrors.cantLockRef.test(msg) || GitErrors.cantLockRef.test(ex.stderr ?? '')) {
				reason = PullErrorReason.RefLocked;
			} else if (
				GitErrors.rebaseMultipleBranches.test(msg) ||
				GitErrors.rebaseMultipleBranches.test(ex.stderr ?? '')
			) {
				reason = PullErrorReason.RebaseMultipleBranches;
			} else if (GitErrors.tagConflict.test(msg) || GitErrors.tagConflict.test(ex.stderr ?? '')) {
				reason = PullErrorReason.TagConflict;
			}

			throw new PullError(reason, ex);
		}
	}

	async reset(
		repoPath: string,
		pathspecs: string[],
		options?: { hard?: boolean; soft?: never; ref?: string } | { soft?: boolean; hard?: never; ref?: string },
	): Promise<void> {
		try {
			const flags = [];
			if (options?.hard) {
				flags.push('--hard');
			} else if (options?.soft) {
				flags.push('--soft');
			}

			if (options?.ref) {
				flags.push(options.ref);
			}
			await this.exec({ cwd: repoPath }, 'reset', '-q', ...flags, '--', ...pathspecs);
		} catch (ex) {
			const msg: string = ex?.toString() ?? '';
			for (const [error, reason] of resetErrorsToReasons) {
				if (error.test(msg) || error.test(ex.stderr ?? '')) {
					throw new ResetError(reason, ex);
				}
			}

			throw new ResetError(ResetErrorReason.Other, ex);
		}
	}

	async rev_parse__currentBranch(
		repoPath: string,
		ordering: 'date' | 'author-date' | 'topo' | null,
		cancellation?: CancellationToken,
	): Promise<[string, string | undefined] | undefined> {
		let result;
		try {
			result = await this.exec(
				{ cwd: repoPath, cancellation: cancellation, errors: GitErrorHandling.Throw },
				'rev-parse',
				'--abbrev-ref',
				'--symbolic-full-name',
				'@',
				'@{u}',
				'--',
			);
			return [result.stdout, undefined];
		} catch (ex) {
			if (isCancellationError(ex)) throw ex;

			const msg: string = ex?.toString() ?? '';
			if (GitErrors.badRevision.test(msg) || GitWarnings.noUpstream.test(msg)) {
				if (ex.stdout != null && ex.stdout.length !== 0) {
					return [ex.stdout, undefined];
				}

				try {
					result = await this.exec(
						{ cwd: repoPath, cancellation: cancellation },
						'symbolic-ref',
						'--short',
						'HEAD',
					);
					if (result.stdout) return [result.stdout.trim(), undefined];
				} catch {
					if (isCancellationError(ex)) throw ex;
				}
				const data = await this.symbolic_ref__HEAD(repoPath, 'origin', cancellation);
				if (data != null) {
					return [data.startsWith('origin/') ? data.substring('origin/'.length) : data, undefined];
				}

				const defaultBranch = (await this.config__get('init.defaultBranch', repoPath)) ?? 'main';
				const branchConfig = await this.config__get_regex(`branch\\.${defaultBranch}\\.+`, repoPath, {
					local: true,
				});

				let remote;
				let remoteBranch;

				if (branchConfig) {
					let match = /^branch\..+\.remote\s(.+)$/m.exec(branchConfig);
					if (match != null) {
						remote = match[1];
					}

					match = /^branch\..+\.merge\srefs\/heads\/(.+)$/m.exec(branchConfig);
					if (match != null) {
						remoteBranch = match[1];
					}
				}
				return [`${defaultBranch}${remote && remoteBranch ? `\n${remote}/${remoteBranch}` : ''}`, undefined];
			}

			if (GitWarnings.headNotABranch.test(msg)) {
				result = await this.exec(
					{
						cwd: repoPath,
						cancellation: cancellation,
						configs: gitConfigsLog,
						errors: GitErrorHandling.Ignore,
					},
					'log',
					'-n1',
					'--format=%H',
					ordering ? `--${ordering}-order` : undefined,
					'--',
				);

				if (result.cancelled || cancellation?.isCancellationRequested) throw new CancellationError();

				const sha = result.stdout.trim();
				if (!sha) return undefined;

				return [`(HEAD detached at ${shortenRevision(sha)})`, sha];
			}

			defaultExceptionHandler(ex, repoPath);
			return undefined;
		}
	}

	async symbolic_ref__HEAD(
		repoPath: string,
		remote: string,
		cancellation?: CancellationToken,
	): Promise<string | undefined> {
		let retried = false;
		while (true) {
			try {
				const result = await this.exec(
					{ cwd: repoPath, cancellation: cancellation },
					'symbolic-ref',
					'--short',
					`refs/remotes/${remote}/HEAD`,
				);
				return result.stdout.trim() || undefined;
			} catch (ex) {
				if (/is not a symbolic ref/.test(ex.stderr)) {
					try {
						if (!retried) {
							retried = true;
							await this.exec(
								{ cwd: repoPath, cancellation: cancellation },
								'remote',
								'set-head',
								'-a',
								remote,
							);
							continue;
						}

						const result = await this.exec(
							{ cwd: repoPath, cancellation: cancellation },
							'ls-remote',
							'--symref',
							remote,
							'HEAD',
						);
						if (result.stdout) {
							const match = /ref:\s(\S+)\s+HEAD/m.exec(result.stdout);
							if (match != null) {
								const [, branch] = match;
								return `${remote}/${branch.substring('refs/heads/'.length).trim()}`;
							}
						}
					} catch {
						if (isCancellationError(ex)) throw ex;
					}
				}

				return undefined;
			}
		}
	}

	async rev_parse__git_dir(cwd: string): Promise<{ path: string; commonPath?: string } | undefined> {
		const result = await this.exec(
			{ cwd: cwd, errors: GitErrorHandling.Ignore },
			'rev-parse',
			'--git-dir',
			'--git-common-dir',
		);
		if (!result.stdout) return undefined;

		// Keep trailing spaces which are part of the directory name
		let [dotGitPath, commonDotGitPath] = result.stdout.split('\n').map(r => r.trimStart());

		// Make sure to normalize: https://github.com/git-for-windows/git/issues/2478

		if (!isAbsolute(dotGitPath)) {
			dotGitPath = joinPaths(cwd, dotGitPath);
		}
		dotGitPath = normalizePath(dotGitPath);

		if (commonDotGitPath) {
			if (!isAbsolute(commonDotGitPath)) {
				commonDotGitPath = joinPaths(cwd, commonDotGitPath);
			}
			commonDotGitPath = normalizePath(commonDotGitPath);

			return { path: dotGitPath, commonPath: commonDotGitPath !== dotGitPath ? commonDotGitPath : undefined };
		}

		return { path: dotGitPath };
	}

	async rev_parse__show_toplevel(cwd: string): Promise<[safe: true, repoPath: string] | [safe: false] | []> {
		let result;

		if (!workspace.isTrusted) {
			// Check if the folder is a bare clone: if it has a file named HEAD && `rev-parse --show-cdup` is empty
			try {
				accessSync(joinPaths(cwd, 'HEAD'));
				result = await this.exec(
					{ cwd: cwd, errors: GitErrorHandling.Throw, configs: ['-C', cwd] },
					'rev-parse',
					'--show-cdup',
				);
				if (!result.stdout.trim()) {
					Logger.log(`Skipping (untrusted workspace); bare clone repository detected in '${cwd}'`);
					return emptyArray as [];
				}
			} catch {
				// If this throw, we should be good to open the repo (e.g. HEAD doesn't exist)
			}
		}

		try {
			result = await this.exec({ cwd: cwd, errors: GitErrorHandling.Throw }, 'rev-parse', '--show-toplevel');
			// Make sure to normalize: https://github.com/git-for-windows/git/issues/2478
			// Keep trailing spaces which are part of the directory name
			return !result.stdout
				? (emptyArray as [])
				: [true, normalizePath(result.stdout.trimStart().replace(/[\r|\n]+$/, ''))];
		} catch (ex) {
			if (ex instanceof WorkspaceUntrustedError) return emptyArray as [];

			const unsafeMatch =
				/(?:^fatal: detected dubious ownership in repository at '([^']+)'|unsafe repository \('([^']+)' is owned by someone else\))[\s\S]*(git config --global --add safe\.directory [^\n•]+)/m.exec(
					ex.stderr,
				);
			if (unsafeMatch != null) {
				Logger.log(
					`Skipping; unsafe repository detected in '${unsafeMatch[1] || unsafeMatch[2]}'; run '${
						unsafeMatch[3]
					}' to allow it`,
				);
				return [false];
			}

			const inDotGit = /this operation must be run in a work tree/.test(ex.stderr);
			// Check if we are in a bare clone
			if (inDotGit && workspace.isTrusted) {
				result = await this.exec(
					{ cwd: cwd, errors: GitErrorHandling.Ignore },
					'rev-parse',
					'--is-bare-repository',
				);
				if (result.stdout.trim() === 'true') {
					const result = await this.rev_parse__git_dir(cwd);
					const repoPath = result?.commonPath ?? result?.path;
					if (repoPath?.length) return [true, repoPath];
				}
			}

			if (inDotGit || ex.code === 'ENOENT') {
				// If the `cwd` doesn't exist, walk backward to see if any parent folder exists
				let exists = inDotGit ? false : await fsExists(cwd);
				if (!exists) {
					do {
						const parent = dirname(cwd);
						if (parent === cwd || parent.length === 0) return emptyArray as [];

						cwd = parent;
						exists = await fsExists(cwd);
					} while (!exists);

					return this.rev_parse__show_toplevel(cwd);
				}
			}
			return emptyArray as [];
		}
	}

	async show__content<T extends string | Buffer>(
		repoPath: string | undefined,
		fileName: string,
		ref: string,
		options?: {
			encoding?: 'binary' | 'ascii' | 'utf8' | 'utf16le' | 'ucs2' | 'base64' | 'latin1' | 'hex' | 'buffer';
		},
	): Promise<T | undefined> {
		const [file, root] = splitPath(fileName, repoPath, true);

		if (isUncommittedStaged(ref)) {
			ref = ':';
		}
		if (isUncommitted(ref)) throw new Error(`ref=${ref} is uncommitted`);

		const opts: GitCommandOptions = {
			configs: gitConfigsLog,
			cwd: root,
			encoding: options?.encoding ?? 'utf8',
			errors: GitErrorHandling.Throw,
		};
		const args = ref.endsWith(':') ? `${ref}./${file}` : `${ref}:./${file}`;

		try {
			const result = await this.exec<T>(opts, 'show', '--textconv', args, '--');
			return result.stdout;
		} catch (ex) {
			const msg: string = ex?.toString() ?? '';
			if (ref === ':' && GitErrors.badRevision.test(msg)) {
				return this.show__content<T>(repoPath, fileName, 'HEAD:', options);
			}

			if (
				GitErrors.badRevision.test(msg) ||
				GitWarnings.notFound.test(msg) ||
				GitWarnings.foundButNotInRevision.test(msg)
			) {
				return undefined;
			}

			defaultExceptionHandler(ex, opts.cwd);
			return '' as T;
		}
	}

	async stash__push(
		repoPath: string,
		message?: string,
		options?: {
			includeUntracked?: boolean;
			keepIndex?: boolean;
			onlyStaged?: boolean;
			pathspecs?: string[];
			stdin?: boolean;
		},
	): Promise<void> {
		const params = ['stash', 'push'];

		if ((options?.includeUntracked || options?.pathspecs?.length) && !options?.onlyStaged) {
			params.push('--include-untracked');
		}

		if (options?.keepIndex && !options?.includeUntracked) {
			params.push('--keep-index');
		}

		if (options?.onlyStaged) {
			if (await this.supports('git:stash:push:staged')) {
				params.push('--staged');
			} else {
				throw new Error(
					`Git version ${gitFeaturesByVersion.get(
						'git:stash:push:staged',
					)}}2.35 or higher is required for --staged`,
				);
			}
		}

		if (message) {
			params.push('-m', message);
		}

		let stdin;
		if (options?.pathspecs?.length) {
			if (options.stdin) {
				stdin = options.pathspecs.join('\0');
				params.push('--pathspec-from-file=-', '--pathspec-file-nul', '--');
			} else {
				params.push('--', ...options.pathspecs);
			}
		} else {
			params.push('--');
		}

		try {
			const result = await this.exec({ cwd: repoPath, stdin: stdin }, ...params);
			if (result.stdout.includes('No local changes to save')) {
				throw new StashPushError(StashPushErrorReason.NothingToSave);
			}
		} catch (ex) {
			if (
				ex instanceof GitError &&
				ex.stdout?.includes('Saved working directory and index state') &&
				ex.stderr?.includes('Cannot remove worktree changes')
			) {
				throw new StashPushError(StashPushErrorReason.ConflictingStagedAndUnstagedLines);
			}
			throw ex;
		}
	}

	async status(
		repoPath: string,
		porcelainVersion: number = 1,
		options?: { similarityThreshold?: number },
		cancellation?: CancellationToken,
		...pathspecs: string[]
	): Promise<GitResult<string>> {
		const params = [
			'status',
			porcelainVersion >= 2 ? `--porcelain=v${porcelainVersion}` : '--porcelain',
			'--branch',
			'-u',
		];
		if (await this.supports('git:status:find-renames')) {
			params.push(
				`--find-renames${options?.similarityThreshold == null ? '' : `=${options.similarityThreshold}%`}`,
			);
		}

		const result = await this.exec(
			{
				cwd: repoPath,
				cancellation: cancellation,
				configs: gitConfigsStatus,
				env: { GIT_OPTIONAL_LOCKS: '0' },
			},
			...params,
			'--',
			...pathspecs,
		);
		return result;
	}

	async tag(repoPath: string, ...args: string[]): Promise<GitResult<string>> {
		try {
			const result = await this.exec({ cwd: repoPath }, 'tag', ...args);
			return result;
		} catch (ex) {
			const msg: string = ex?.toString() ?? '';
			for (const [error, reason] of tagErrorsToReasons) {
				if (error.test(msg) || error.test(ex.stderr ?? '')) {
					throw new TagError(reason, ex);
				}
			}
			throw new TagError(TagErrorReason.Other, ex);
		}
	}

	async readDotGitFile(
		gitDir: GitDir,
		pathParts: string[],
		options?: { numeric?: false; throw?: boolean; trim?: boolean },
	): Promise<string | undefined>;
	async readDotGitFile(
		gitDir: GitDir,
		pathParts: string[],
		options?: { numeric: true; throw?: boolean; trim?: boolean },
	): Promise<number | undefined>;
	async readDotGitFile(
		gitDir: GitDir,
		pathParts: string[],
		options?: { numeric?: boolean; throw?: boolean; trim?: boolean },
	): Promise<string | number | undefined> {
		try {
			const bytes = await workspace.fs.readFile(Uri.joinPath(gitDir.uri, ...pathParts));
			let contents = textDecoder.decode(bytes);
			contents = (options?.trim ?? true) ? contents.trim() : contents;

			if (options?.numeric) {
				const number = Number.parseInt(contents, 10);
				return isNaN(number) ? undefined : number;
			}

			return contents;
		} catch (ex) {
			if (options?.throw) throw ex;

			return undefined;
		}
	}
	@log()
	async runGitCommandViaTerminal(
		cwd: string,
		command: string,
		args: string[],
		options?: { execute?: boolean },
	): Promise<void> {
		const scope = getLogScope();

		const location = await this.getLocation();
		const git = normalizePath(location.path ?? 'git');

		const coreEditorConfig = configuration.get('terminal.overrideGitEditor')
			? `-c "core.editor=${await getHostEditorCommand()}" `
			: '';

		const parsedArgs = args.map(arg => (arg.startsWith('#') || /['();$|>&<]/.test(arg) ? `"${arg}"` : arg));

		let text;
		if (git.includes(' ')) {
			const shell = env.shell;
			Logger.debug(scope, `\u2022 git path '${git}' contains spaces, detected shell: '${shell}'`);

			text = `${
				(isWindows ? /(pwsh|powershell)\.exe/i : /pwsh/i).test(shell) ? '&' : ''
			} "${git}" -C "${cwd}" ${coreEditorConfig}${command} ${parsedArgs.join(' ')}`;
		} else {
			text = `${git} -C "${cwd}" ${coreEditorConfig}${command} ${parsedArgs.join(' ')}`;
		}

		Logger.log(scope, `\u2022 '${text}'`);
		this.logCore(`${getLoggableScopeBlockOverride('TERMINAL')} ${text}`);

		const terminal = ensureGitTerminal();
		terminal.show(false);
		// Removing this as this doesn't seem to work on bash
		// // Sends ansi codes to remove any text on the current input line
		// terminal.sendText('\x1b[2K\x1b', false);
		terminal.sendText(text, options?.execute ?? false);
	}

	private logGitCommand(command: string, ex: Error | undefined, duration: number, waiting: boolean): void {
		const slow = duration > slowCallWarningThreshold;
		const status = slow && waiting ? ' (slow, waiting)' : waiting ? ' (waiting)' : slow ? ' (slow)' : '';

		if (ex != null) {
			Logger.error(
				undefined,
				`${getLoggableScopeBlockOverride('GIT')} ${command} ${GlyphChars.Dot} ${
					isCancellationError(ex)
						? 'cancelled'
						: (ex.message || String(ex) || '')
								.trim()
								.replace(/fatal: /g, '')
								.replace(/\r?\n|\r/g, ` ${GlyphChars.Dot} `)
				} [${duration}ms]${status}`,
			);
		} else if (slow) {
			Logger.warn(
				`${getLoggableScopeBlockOverride('GIT', `*${duration}ms`)} ${command} [*${duration}ms]${status}`,
			);
		} else {
			Logger.log(`${getLoggableScopeBlockOverride('GIT', `${duration}ms`)} ${command} [${duration}ms]${status}`);
		}

		this.logCore(`${getLoggableScopeBlockOverride(slow ? '*' : '', `${duration}ms`)} ${command}${status}`, ex);
	}

	private _gitOutput: OutputChannel | undefined;

	private logCore(message: string, ex?: Error | undefined): void {
		if (!Logger.enabled(ex != null ? 'error' : 'debug')) return;

		this._gitOutput ??= window.createOutputChannel('GitLens (Git)', { log: true });
		this._gitOutput.appendLine(`${Logger.timestamp} ${message}${ex != null ? ` ${GlyphChars.Dot} FAILED` : ''}`);
		if (ex != null) {
			this._gitOutput.appendLine(`\n${String(ex)}\n`);
		}
	}
}
