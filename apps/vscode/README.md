# FrontAgent

FrontAgent can now be used in two ways: the original `fa` CLI for terminal-first workflows, and this VS Code extension for a sidebar chat workflow.

This extension brings FrontAgent into VS Code as a Copilot-style sidebar chat. Configure your model once, attach the current file or selection, and ask FrontAgent to explain, edit, or debug your workspace without leaving the editor.

## Usage

1. Install the extension from the VS Code Marketplace.
2. Open a project folder in VS Code.
3. Run `FrontAgent: Configure` and set your OpenAI-compatible or Anthropic API key.
4. Open the FrontAgent chat view from the Activity Bar.
5. Ask a question or request an edit, optionally with the current file, selected text, or a browser URL attached.

You can still use the CLI in the same project:

```bash
fa init
fa run "Create a user login page"
```

## Features

- Chat with FrontAgent from the Activity Bar.
- Use the current file or selected text as chat context.
- Attach a browser URL as task context.
- Review phase, step, and RAG details in a collapsible run panel.
- Approve or reject sensitive tool actions inline.
- Initialize and validate `sdd.yaml`.
- Open run logs written under `.frontagent/runs`.

## Requirements

FrontAgent for VS Code is a desktop extension. It uses Node.js, local file system access, shell tooling, and browser automation capabilities from the FrontAgent runtime.

Configure a provider, model, base URL, and API key with `FrontAgent: Configure` or the sidebar configuration panel before running tasks. API keys entered there are stored in VS Code SecretStorage, and the provider, model, and base URL are written to your **User Settings**. You can also use `frontagent.apiKey` in User Settings as a fallback when you explicitly want a settings-based key.

## Endpoint Trust

The provider, model, and base URL decide which host receives your API key and your task context, so FrontAgent treats them as user-scoped configuration.

A repository can put these keys in its own `.vscode/settings.json`, and VS Code ranks folder settings above User Settings. FrontAgent therefore resolves them per scope instead of taking the merged value:

- A workspace-supplied `provider`, `model`, or `baseUrl` that differs from your own is **not used** until you confirm it. The confirmation dialog names the destination host before the first request is made.
- Your approval is bound to that workspace folder and to that exact provider/model/base URL. If the repository later changes any of them, FrontAgent asks again.
- FrontAgent declares no `untrustedWorkspaces` support, so VS Code disables the extension entirely in Restricted Mode. The resolver additionally ignores workspace endpoint values whenever the workspace is not trusted, as defence in depth.
- `frontagent.apiKey` is `machine`-scoped: it is read only from your User Settings and never from a workspace.

Run `FrontAgent: Reset Workspace Endpoint Approval` to revoke an approval for the current workspace, or to be asked again after declining.

> **Upgrading?** Earlier versions of `FrontAgent: Configure` saved to workspace settings. Those values are not migrated, so after running the new Configure they still sit in `.vscode/settings.json` (or your `.code-workspace`) and will keep being treated as a workspace override — you will be asked to confirm them. Delete them from the workspace file once your settings are in User Settings.

### Using a different model per project

`FrontAgent: Configure` and the sidebar form now save to User Settings, so they set your default for every workspace rather than for the project you happen to have open. To vary the model or endpoint per project, put it in that project's `.vscode/settings.json` and approve the prompt once — the approval is remembered for that folder. This is the trade for making a repository unable to silently choose where your API key goes.

## Extension Settings

- `frontagent.provider`: LLM provider, `anthropic` or `openai`. Workspace values need confirmation.
- `frontagent.model`: Model name. Workspace values need confirmation.
- `frontagent.baseUrl`: API base URL. Workspace values need confirmation.
- `frontagent.apiKey`: Optional API key fallback, User Settings only; SecretStorage is recommended.
- `frontagent.maxTokens`: Maximum output tokens.
- `frontagent.temperature`: Sampling temperature.
- `frontagent.securityMode`: Tool execution security mode.
- `frontagent.rag.enabled`: Enable the remote knowledge-base RAG flow.
- `frontagent.rag.repo`: Knowledge-base Git repository.
- `frontagent.rag.branch`: Knowledge-base branch.
- `frontagent.runLog.enabled`: Enable run logs.

Use `FrontAgent: Show Extension Logs` to inspect activation, command registration, runtime loading, and webview errors.

## Known Limits

- Web extensions are not supported.
- Only one active FrontAgent run is allowed per workspace in this first version.
- Cancel is cooperative and stops at phase/step boundaries.
