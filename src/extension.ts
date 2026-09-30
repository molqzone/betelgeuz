/** Extension entry point; activation registers the VS Code surface only. */
import * as vscode from "vscode";

import { ExtensionController } from "./surface/controller";

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(new ExtensionController(context));
}

export function deactivate(): void {}
