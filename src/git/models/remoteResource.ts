import type { Range } from 'vscode';
import type { GitCommit } from './commit';

export const enum RemoteResourceType {
	Branch = 'branch',
	Branches = 'branches',
	Commit = 'commit',
	Comparison = 'comparison',
	CreatePullRequest = 'createPullRequest',
	File = 'file',
	Repo = 'repo',
	Revision = 'revision',
	// Tag = 'tag',
}

export type RemoteResource =
	| {
			type: RemoteResourceType.Branch;
			branch: string;
	  }
	| {
			type: RemoteResourceType.Branches;
	  }
	| {
			type: RemoteResourceType.Commit;
			sha: string;
	  }
	| {
			type: RemoteResourceType.Comparison;
			base: string;
			compare: string;
			notation?: '..' | '...';
	  }
	| {
			type: RemoteResourceType.CreatePullRequest;
			base: {
				branch?: string;
				remote: { path: string; url: string };
			};
			compare: {
				branch: string;
				remote: { path: string; url: string };
			};
	  }
	| {
			type: RemoteResourceType.File;
			branchOrTag?: string;
			fileName: string;
			range?: Range;
	  }
	| {
			type: RemoteResourceType.Repo;
	  }
	| {
			type: RemoteResourceType.Revision;
			branchOrTag?: string;
			commit?: GitCommit;
			fileName: string;
			range?: Range;
			sha?: string;
	  };
