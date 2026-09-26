import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext): void {
  const disposable = vscode.commands.registerCommand("betelgeuz.helloWorld", () => {
    void vscode.window.showInformationMessage("Hello from Betelgeuz!");
  });

  context.subscriptions.push(disposable);
}

export function deactivate(): void {}
