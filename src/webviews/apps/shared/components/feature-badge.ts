import { consume } from '@lit/context';
import type { TemplateResult } from 'lit';
import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { proTrialLengthInDays, SubscriptionState } from '../../../../constants.subscription';
import type { Source } from '../../../../constants.telemetry';
import type { Subscription, SubscriptionUpgradeCommandArgs } from '../../../../plus/gk/models/subscription';
import {
	getSubscriptionProductPlanName,
	getSubscriptionTimeRemaining,
	isSubscriptionPaid,
	isSubscriptionTrial,
} from '../../../../plus/gk/utils/subscription.utils';
import { createCommandLink } from '../../../../system/commands';
import { pluralize } from '../../../../system/string';
import type { PromosContext } from '../contexts/promos';
import { promosContext } from '../contexts/promos';
import type { GlPopover } from './overlays/popover';
import { focusOutline } from './styles/lit/a11y.css';
import { elementBase, linkBase } from './styles/lit/base.css';
import './overlays/popover';
import './overlays/tooltip';
import './promo';

declare global {
	interface HTMLElementTagNameMap {
		'gl-feature-badge': GlFeatureBadge;
	}

	// interface GlobalEventHandlersEventMap {}
}

@customElement('gl-feature-badge')
export class GlFeatureBadge extends LitElement {
	static override styles = [
		elementBase,
		linkBase,
		css`
			:host {
				/* position: relative; */
				display: inline-block;
				--gl-feature-badge-color: currentColor;
				--gl-feature-badge-border-color: var(--color-foreground--50);
				--max-width: 40rem;
			}

			a {
				color: var(--color-link);
				text-decoration: underline;
			}

			.badge {
				color: var(--gl-feature-badge-color, currentColor);
				cursor: help;
				font-size: var(--gl-feature-badge-font-size, x-small);
				font-variant: all-small-caps;
				font-weight: 600;
				border: 1px solid var(--gl-feature-badge-border-color, var(--color-foreground--50));
				border-radius: 1rem;
				padding: 0 0.8rem 0.1rem 0.8rem;
				white-space: nowrap;
			}

			.badge:focus-visible {
				${unsafeCSS(focusOutline)}
			}

			.badge-icon {
				font-weight: 400;
				margin-left: 0.4rem;
				white-space: nowrap;
			}

			.badge-popup {
				display: flex;
				flex-direction: column;
				white-space: normal;
				gap: 0.6rem;
			}

			.popup-header {
				display: flex;
				flex-direction: column;
				margin-bottom: 0.4rem;
			}

			.popup-title {
				font-size: 1.3rem;
				font-weight: 600;
			}

			.popup-subtitle {
				font-size: smaller;
				margin-top: 0.6rem;
			}

			.popup-content {
				display: flex;
				flex-direction: column;
				border-top: 1px solid var(--color-foreground--25);
				padding-top: 0.6rem;
			}

			.popup-content p {
				margin: 0;
			}

			.popup-content .actions {
				margin-top: 0.8rem;
				margin-bottom: 0.6rem;
			}

			.popup-content .actions:first-child {
				margin-bottom: 0.8rem;
			}

			.popup-content .actions :not(:first-child) {
				margin-top: 0.4rem;
			}

			.popup-content .actions gl-button:not(:first-child) {
				margin-top: 0.8rem;
			}

			.hint {
				border-bottom: 1px dashed currentColor;
			}
		`,
	];

	@property({ type: Boolean })
	cloud: boolean = false;

	@property({ reflect: true })
	placement: GlPopover['placement'] = 'bottom';

	@property({ type: Boolean })
	preview: boolean = false;

	@consume({ context: promosContext })
	private promos!: PromosContext;

	@property({ type: Object })
	source?: Source;

	@property({ attribute: false })
	subscription?: Subscription;

	private get daysRemaining() {
		if (this.subscription == null) return 0;

		return getSubscriptionTimeRemaining(this.subscription, 'days') ?? 0;
	}

	private get state() {
		return this.subscription?.state;
	}

	override render(): unknown {
		return html`
			<gl-popover placement=${this.placement} hoist>
				<span slot="anchor" class="badge" tabindex="0">${this.renderBadge()}</span>
				<div slot="content" class="badge-popup" tabindex="-1">
					${this.renderPopoverHeader()}${this.renderPopoverContent()}
				</div>
			</gl-popover>
		`;
	}

	private renderBadge() {
		const text = this.preview ? 'Preview' : 'Pro';

		if (this.subscription != null) {
			if (this.state === SubscriptionState.VerificationRequired) {
				return html`${text} <code-icon class="badge-icon" icon="warning" size="10"></code-icon>`;
			} else if (isSubscriptionPaid(this.subscription) || (this.cloud && this.subscription.account != null)) {
				return html`${text} <code-icon class="badge-icon" icon="check" size="10"></code-icon>`;
			} else if (isSubscriptionTrial(this.subscription)) {
				return html`${text} <code-icon class="badge-icon" icon="clock" size="10"></code-icon>`;
			}
		}

		return text;
	}

	private renderPopoverHeader() {
		const text = html`<span class="popup-title">${this.preview ? 'Preview feature' : 'Pro feature'}</span>`;

		if (this.state === SubscriptionState.Paid) {
			return html`<div class="popup-header">${text}</div>`;
		}

		if (this.cloud) {
			if (this.preview) {
				return html`<div class="popup-header">
					${text}<span class="popup-subtitle"
						>Requires an account and may require GitLens Pro in the future</span
					>
				</div>`;
			}

			return html`<div class="popup-header">
				${text}<span class="popup-subtitle"> Requires GitLens Pro</span>
			</div>`;
		}

		if (this.preview) {
			return html`<div class="popup-header">
				${text}<span class="popup-subtitle">May require GitLens Pro in the future</span>
			</div>`;
		}

		return html`<div class="popup-header">
			${text}<span class="popup-subtitle"> Requires GitLens Pro for use on privately-hosted repos</span>
		</div>`;
	}

	private renderPopoverContent() {
		if (this.subscription == null) return nothing;

		let content;
		switch (this.state) {
			case SubscriptionState.Paid:
				content = html`<p>
					Your
					<gl-tooltip hoist content="Show Account view">
						<a href="${createCommandLink('gitlens.showAccountView')}"
							>${getSubscriptionProductPlanName(this.subscription?.plan.actual.id ?? 'pro')}</a
						>
					</gl-tooltip>
					plan provides access to all Pro features.
				</p>`;
				break;

			case SubscriptionState.VerificationRequired:
				content = html`<p>You must verify your email before you can access Pro features.</p>
					<div class="actions">
						<gl-button
							density="tight"
							href="${createCommandLink<Source>('gitlens.plus.resendVerification', this.source)}"
							>Resend Email</gl-button
						>
						<gl-button
							appearance="secondary"
							density="tight"
							href="${createCommandLink<Source>('gitlens.plus.validate', this.source)}"
							><code-icon icon="refresh"></code-icon
						></gl-button>
					</div>`;
				break;

			case SubscriptionState.Trial: {
				const days = this.daysRemaining;

				content = html`<p>
						You have
						<strong>${days < 1 ? '<1 day' : pluralize('day', days, { infix: ' more ' })} left</strong>
						in your Pro trial. Once your trial ends, you will only be able to use Pro features on
						publicly-hosted repos.
					</p>
					${this.renderUpgradeActions()}`;
				break;
			}

			case SubscriptionState.TrialExpired:
				content = html`<p>
						Your Pro trial has ended. You can now only use Pro features on publicly-hosted repos.
					</p>
					${this.renderUpgradeActions(
						html`<p>Please upgrade for full access to all GitLens Pro features:</p>`,
					)}`;
				break;

			case SubscriptionState.TrialReactivationEligible:
				content = html`<p>
						Reactivate your Pro trial and experience all the new Pro features — free for another
						${pluralize('day', proTrialLengthInDays)}!
					</p>
					<div class="actions center">
						<gl-button
							density="tight"
							href="${createCommandLink<Source>('gitlens.plus.reactivateProTrial', this.source)}"
							tooltip="Reactivate your Pro trial for another ${pluralize('day', proTrialLengthInDays)}"
							>Reactivate Pro Trial</gl-button
						>
					</div>`;
				break;

			default:
				content = html`<p>
						You only have access to
						<gl-tooltip hoist content="Pro features that do not require an account"
							><span class="hint">local</span></gl-tooltip
						>
						Pro features on publicly-hosted repos.
					</p>
					${this.renderStartTrialActions()}`;
				break;
		}

		return html`<div class="popup-content">${content}</div>`;
	}

	private renderStartTrialActions() {
		return html`<div class="actions">
			<p>For access to all Pro features:</p>
			<gl-button density="tight" href="${createCommandLink<Source>('gitlens.plus.signUp', this.source)}"
				>Start ${proTrialLengthInDays}-day Pro Trial</gl-button
			>
			&nbsp;or
			<a href="${createCommandLink<Source>('gitlens.plus.login', this.source)}" title="Sign In">sign in</a>
		</div>`;
	}

	private renderUpgradeActions(leadin?: TemplateResult) {
		return html`<div class="actions">
			${leadin ?? nothing}
			<gl-button
				density="tight"
				href="${createCommandLink<SubscriptionUpgradeCommandArgs>('gitlens.plus.upgrade', {
					plan: 'pro',
					...(this.source ?? { source: 'feature-badge' }),
				})}"
				>Upgrade to Pro</gl-button
			>
			${this.renderPromo()}
		</div>`;
	}

	private renderPromo() {
		return html`<gl-promo
			.promoPromise=${this.promos.getApplicablePromo(undefined, 'badge')}
			.source=${this.source}
		></gl-promo>`;
	}
}
