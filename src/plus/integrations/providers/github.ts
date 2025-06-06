import type { AuthenticationSession, CancellationToken, EventEmitter } from 'vscode';
import { GitCloudHostIntegrationId, GitSelfManagedHostIntegrationId } from '../../../constants.integrations';
import type { Sources } from '../../../constants.telemetry';
import type { Container } from '../../../container';
import type { Account, UnidentifiedAuthor } from '../../../git/models/author';
import type { DefaultBranch } from '../../../git/models/defaultBranch';
import type { Issue, IssueShape } from '../../../git/models/issue';
import type { IssueOrPullRequest } from '../../../git/models/issueOrPullRequest';
import type { PullRequest, PullRequestMergeMethod, PullRequestState } from '../../../git/models/pullRequest';
import type { RepositoryMetadata } from '../../../git/models/repositoryMetadata';
import type { RepositoryDescriptor } from '../../../git/models/resourceDescriptor';
import type { PullRequestUrlIdentity } from '../../../git/utils/pullRequest.utils';
import { log } from '../../../system/decorators/log';
import { ensurePaidPlan } from '../../gk/utils/-webview/plus.utils';
import type { IntegrationAuthenticationProviderDescriptor } from '../authentication/integrationAuthenticationProvider';
import type { IntegrationAuthenticationService } from '../authentication/integrationAuthenticationService';
import type { IntegrationConnectionChangeEvent } from '../integrationService';
import { GitHostIntegration } from '../models/gitHostIntegration';
import type { GitHubIntegrationIds } from './github/github.utils';
import { getGitHubPullRequestIdentityFromMaybeUrl } from './github/github.utils';
import { providersMetadata } from './models';
import type { ProvidersApi } from './providersApi';

const metadata = providersMetadata[GitCloudHostIntegrationId.GitHub];
const authProvider: IntegrationAuthenticationProviderDescriptor = Object.freeze({
	id: metadata.id,
	scopes: metadata.scopes,
});

const enterpriseMetadata = providersMetadata[GitSelfManagedHostIntegrationId.GitHubEnterprise];
const enterpriseAuthProvider: IntegrationAuthenticationProviderDescriptor = Object.freeze({
	id: enterpriseMetadata.id,
	scopes: enterpriseMetadata.scopes,
});
const cloudEnterpriseMetadata = providersMetadata[GitSelfManagedHostIntegrationId.CloudGitHubEnterprise];
const cloudEnterpriseAuthProvider: IntegrationAuthenticationProviderDescriptor = Object.freeze({
	id: cloudEnterpriseMetadata.id,
	scopes: cloudEnterpriseMetadata.scopes,
});

export type GitHubRepositoryDescriptor = RepositoryDescriptor;

abstract class GitHubIntegrationBase<ID extends GitHubIntegrationIds> extends GitHostIntegration<
	ID,
	GitHubRepositoryDescriptor
> {
	protected abstract get apiBaseUrl(): string;

	protected override async getProviderAccountForCommit(
		{ accessToken }: AuthenticationSession,
		repo: GitHubRepositoryDescriptor,
		rev: string,
		options?: {
			avatarSize?: number;
		},
	): Promise<Account | UnidentifiedAuthor | undefined> {
		return (await this.container.github)?.getAccountForCommit(this, accessToken, repo.owner, repo.name, rev, {
			...options,
			baseUrl: this.apiBaseUrl,
		});
	}

	protected override async getProviderAccountForEmail(
		{ accessToken }: AuthenticationSession,
		repo: GitHubRepositoryDescriptor,
		email: string,
		options?: {
			avatarSize?: number;
		},
	): Promise<Account | undefined> {
		return (await this.container.github)?.getAccountForEmail(this, accessToken, repo.owner, repo.name, email, {
			...options,
			baseUrl: this.apiBaseUrl,
		});
	}

	protected override async getProviderDefaultBranch(
		{ accessToken }: AuthenticationSession,
		repo: GitHubRepositoryDescriptor,
	): Promise<DefaultBranch | undefined> {
		return (await this.container.github)?.getDefaultBranch(this, accessToken, repo.owner, repo.name, {
			baseUrl: this.apiBaseUrl,
		});
	}

	protected override async getProviderIssueOrPullRequest(
		{ accessToken }: AuthenticationSession,
		repo: GitHubRepositoryDescriptor,
		id: string,
	): Promise<IssueOrPullRequest | undefined> {
		return (await this.container.github)?.getIssueOrPullRequest(
			this,
			accessToken,
			repo.owner,
			repo.name,
			Number(id),
			{
				baseUrl: this.apiBaseUrl,
			},
		);
	}

	protected override async getProviderIssue(
		{ accessToken }: AuthenticationSession,
		repo: GitHubRepositoryDescriptor,
		id: string,
	): Promise<Issue | undefined> {
		return (await this.container.github)?.getIssue(this, accessToken, repo.owner, repo.name, Number(id), {
			baseUrl: this.apiBaseUrl,
			includeBody: true,
		});
	}

	protected override async getProviderPullRequest(
		{ accessToken }: AuthenticationSession,
		repo: GitHubRepositoryDescriptor,
		id: string,
	): Promise<PullRequest | undefined> {
		return (await this.container.github)?.getPullRequest(
			this,
			accessToken,
			repo.owner,
			repo.name,
			parseInt(id, 10),
			{
				baseUrl: this.apiBaseUrl,
			},
		);
	}

	protected override async getProviderPullRequestForBranch(
		{ accessToken }: AuthenticationSession,
		repo: GitHubRepositoryDescriptor,
		branch: string,
		options?: {
			avatarSize?: number;
			include?: PullRequestState[];
		},
	): Promise<PullRequest | undefined> {
		const { include, ...opts } = options ?? {};

		const toGitHubPullRequestState = (await import(/* webpackChunkName: "integrations" */ './github/models'))
			.toGitHubPullRequestState;
		return (await this.container.github)?.getPullRequestForBranch(
			this,
			accessToken,
			repo.owner,
			repo.name,
			branch,
			{
				...opts,
				include: include?.map(s => toGitHubPullRequestState(s)),
				baseUrl: this.apiBaseUrl,
			},
		);
	}

	protected override async getProviderPullRequestForCommit(
		{ accessToken }: AuthenticationSession,
		repo: GitHubRepositoryDescriptor,
		rev: string,
	): Promise<PullRequest | undefined> {
		return (await this.container.github)?.getPullRequestForCommit(this, accessToken, repo.owner, repo.name, rev, {
			baseUrl: this.apiBaseUrl,
		});
	}

	protected override async getProviderRepositoryMetadata(
		{ accessToken }: AuthenticationSession,
		repo: GitHubRepositoryDescriptor,
		cancellation?: CancellationToken,
	): Promise<RepositoryMetadata | undefined> {
		return (await this.container.github)?.getRepositoryMetadata(
			this,
			accessToken,
			repo.owner,
			repo.name,
			{
				baseUrl: this.apiBaseUrl,
			},
			cancellation,
		);
	}

	protected override async searchProviderMyPullRequests(
		{ accessToken }: AuthenticationSession,
		repos?: GitHubRepositoryDescriptor[],
		cancellation?: CancellationToken,
		silent?: boolean,
	): Promise<PullRequest[] | undefined> {
		return (await this.container.github)?.searchMyPullRequests(
			this,
			accessToken,
			{
				repos: repos?.map(r => `${r.owner}/${r.name}`),
				baseUrl: this.apiBaseUrl,
				silent: silent,
			},
			cancellation,
		);
	}

	protected override async searchProviderMyIssues(
		{ accessToken }: AuthenticationSession,
		repos?: GitHubRepositoryDescriptor[],
		cancellation?: CancellationToken,
	): Promise<IssueShape[] | undefined> {
		return (await this.container.github)?.searchMyIssues(
			this,
			accessToken,
			{
				repos: repos?.map(r => `${r.owner}/${r.name}`),
				baseUrl: this.apiBaseUrl,
				includeBody: true,
			},
			cancellation,
		);
	}

	protected override async searchProviderPullRequests(
		{ accessToken }: AuthenticationSession,
		searchQuery: string,
		repos?: GitHubRepositoryDescriptor[],
		cancellation?: CancellationToken,
	): Promise<PullRequest[] | undefined> {
		return (await this.container.github)?.searchPullRequests(
			this,
			accessToken,
			{
				search: searchQuery,
				repos: repos?.map(r => `${r.owner}/${r.name}`),
				baseUrl: this.apiBaseUrl,
			},
			cancellation,
		);
	}

	protected override async mergeProviderPullRequest(
		{ accessToken }: AuthenticationSession,
		pr: PullRequest,
		options?: {
			mergeMethod?: PullRequestMergeMethod;
		},
	): Promise<boolean> {
		const id = pr.nodeId;
		const headRefSha = pr.refs?.head?.sha;
		if (id == null || headRefSha == null) return false;
		return (
			(await this.container.github)?.mergePullRequest(this, accessToken, id, headRefSha, {
				mergeMethod: options?.mergeMethod,
				baseUrl: this.apiBaseUrl,
			}) ?? false
		);
	}

	protected override async getProviderCurrentAccount(
		{ accessToken }: AuthenticationSession,
		options?: { avatarSize?: number },
	): Promise<Account | undefined> {
		return (await this.container.github)?.getCurrentAccount(this, accessToken, {
			...options,
			baseUrl: this.apiBaseUrl,
		});
	}

	protected override getProviderPullRequestIdentityFromMaybeUrl(search: string): PullRequestUrlIdentity | undefined {
		return getGitHubPullRequestIdentityFromMaybeUrl(search, this.id);
	}
}

export class GitHubIntegration extends GitHubIntegrationBase<GitCloudHostIntegrationId.GitHub> {
	readonly authProvider = authProvider;
	readonly id = GitCloudHostIntegrationId.GitHub;
	protected readonly key = this.id;
	readonly name: string = 'GitHub';
	get domain(): string {
		return metadata.domain;
	}

	protected override get apiBaseUrl(): string {
		return 'https://api.github.com';
	}

	override access(): Promise<boolean> {
		// Always allow GitHub cloud integration access
		return Promise.resolve(true);
	}

	// This is a special case for GitHub because we use VSCode's GitHub session, and it can be disconnected
	// outside of the extension.
	override async refresh(): Promise<void> {
		const authProvider = await this.authenticationService.get(this.authProvider.id);
		const session = await authProvider.getSession(this.authProviderDescriptor);
		if (session == null && this.maybeConnected) {
			void this.disconnect({ silent: true });
		} else {
			if (session?.accessToken !== this._session?.accessToken) {
				this._session = undefined;
			}
			super.refresh();
		}
	}
}

export class GitHubEnterpriseIntegration extends GitHubIntegrationBase<
	GitSelfManagedHostIntegrationId.GitHubEnterprise | GitSelfManagedHostIntegrationId.CloudGitHubEnterprise
> {
	readonly authProvider;
	protected readonly key;
	readonly name = 'GitHub Enterprise';
	get domain(): string {
		return this._domain;
	}

	protected override get apiBaseUrl(): string {
		return `https://${this._domain}/api/v3`;
	}

	constructor(
		container: Container,
		authenticationService: IntegrationAuthenticationService,
		getProvidersApi: () => Promise<ProvidersApi>,
		didChangeConnection: EventEmitter<IntegrationConnectionChangeEvent>,
		private readonly _domain: string,
		readonly id:
			| GitSelfManagedHostIntegrationId.GitHubEnterprise
			| GitSelfManagedHostIntegrationId.CloudGitHubEnterprise,
	) {
		super(container, authenticationService, getProvidersApi, didChangeConnection);
		this.key = `${this.id}:${this.domain}` as const;
		this.authProvider =
			this.id === GitSelfManagedHostIntegrationId.GitHubEnterprise
				? enterpriseAuthProvider
				: cloudEnterpriseAuthProvider;
	}

	@log()
	override async connect(source: Sources): Promise<boolean> {
		if (
			!(await ensurePaidPlan(this.container, `Rich integration with ${this.name} is a Pro feature.`, {
				source: 'integrations',
				detail: { action: 'connect', integration: this.id },
			}))
		) {
			return false;
		}

		return super.connect(source);
	}
}
