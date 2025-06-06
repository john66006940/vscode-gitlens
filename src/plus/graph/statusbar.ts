import type { ConfigurationChangeEvent, StatusBarItem } from 'vscode';
import { Disposable, MarkdownString, StatusBarAlignment, window } from 'vscode';
import type { GlCommands } from '../../constants.commands';
import type { Container } from '../../container';
import { configuration } from '../../system/-webview/configuration';
import { getContext, onDidChangeContext } from '../../system/-webview/context';
import { once } from '../../system/function';
import type { SubscriptionChangeEvent } from '../gk/subscriptionService';
import { arePlusFeaturesEnabled } from '../gk/utils/-webview/plus.utils';

export class GraphStatusBarController implements Disposable {
	private readonly _disposable: Disposable;
	private _statusBarItem: StatusBarItem | undefined;

	constructor(container: Container) {
		this._disposable = Disposable.from(
			configuration.onDidChange(this.onConfigurationChanged, this),
			container.subscription.onDidChange(this.onSubscriptionChanged, this),
			once(container.onReady)(() => queueMicrotask(() => this.updateStatusBar())),
			onDidChangeContext(key => {
				if (key !== 'gitlens:enabled' && key !== 'gitlens:plus:disabled') return;
				this.updateStatusBar();
			}),
			{ dispose: () => this._statusBarItem?.dispose() },
		);
	}

	dispose(): void {
		this._disposable.dispose();
	}

	private onConfigurationChanged(e: ConfigurationChangeEvent) {
		if (configuration.changed(e, 'graph.statusBar.enabled') || configuration.changed(e, 'plusFeatures.enabled')) {
			this.updateStatusBar();
		}
	}

	private onSubscriptionChanged(_e: SubscriptionChangeEvent) {
		this.updateStatusBar();
	}

	private updateStatusBar() {
		const enabled =
			configuration.get('graph.statusBar.enabled') && getContext('gitlens:enabled') && arePlusFeaturesEnabled();
		if (enabled) {
			if (this._statusBarItem == null) {
				this._statusBarItem = window.createStatusBarItem('gitlens.graph', StatusBarAlignment.Left, 10000 - 2);
				this._statusBarItem.name = 'GitLens Commit Graph';
				this._statusBarItem.command = 'gitlens.showGraph' satisfies GlCommands;
				this._statusBarItem.text = '$(gitlens-graph)';
				this._statusBarItem.tooltip = new MarkdownString('Visualize commits on the Commit Graph');
				this._statusBarItem.accessibilityInformation = {
					label: `Show the GitLens Commit Graph`,
				};
			}
			this._statusBarItem.show();
		} else {
			this._statusBarItem?.dispose();
			this._statusBarItem = undefined;
		}
	}
}
