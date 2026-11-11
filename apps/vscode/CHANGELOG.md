# Changelog

## Unreleased

- Security: endpoint settings committed by a repository in `.vscode/settings.json` no longer select the host that receives your API key and task context. `frontagent.provider`, `frontagent.model`, and `frontagent.baseUrl` are resolved per scope; a workspace-supplied value is withheld until you approve that exact endpoint, and is ignored entirely when the workspace is not trusted.
- **Breaking:** `frontagent.apiKey` is `machine`-scoped and read only from User Settings. A key previously set in workspace settings stops being honoured; move it to User Settings or, preferably, run `FrontAgent: Configure` to store it in SecretStorage.
- **Breaking:** `FrontAgent: Configure` and the sidebar form now save to User Settings, so they set your default for every workspace. The sidebar form also prefills only from User Settings; values coming from the environment or from an approved workspace endpoint now appear as a placeholder rather than as editable text, so saving cannot copy them into your user configuration by accident. To vary the model or endpoint per project, set it in that project's `.vscode/settings.json` and approve the prompt once.
- `FrontAgent: Configure` and the sidebar Configure form now save provider, model, and base URL to User Settings instead of Workspace settings, so a repository cannot overwrite them. Configure also prefills from User Settings, so accepting the dialog cannot promote a repository-supplied endpoint into your user configuration.
- A dismissed endpoint prompt is remembered for the rest of the session rather than reappearing on every message, and the sidebar then points at the reset command instead of an approval prompt that will not reappear.
- Security: repository-supplied values are flattened to a single bounded line before they appear in the confirmation dialog, so a repository cannot use newlines to inject its own sentences or push the warning out of view.
- Added `FrontAgent: Reset Workspace Endpoint Approval` to revoke a previously approved workspace endpoint.

## 2.2.0

- Aligned the extension package with the FrontAgent `2.2.0` release.
- Bundled runtime migrated to the AI SDK v5 line; the OpenAI provider now explicitly targets the Chat Completions endpoint for OpenAI-compatible base URLs.
- Inherited the guard, planner, session-resume, and lifecycle-hook fixes from the 2.2.0 core packages.
- Kept the minimum VS Code engine requirement at `^1.120.0`.
- Build output now packages the `frontagent-2.2.0.vsix` artifact through the root `pnpm build` script.

## 2.1.1

- Aligned the extension package with the FrontAgent `2.1.1` release.
- Split the sidebar webview HTML implementation into focused body, script, style, and template renderers.
- Added focused webview renderer tests to preserve sidebar behavior while making future UI changes easier to review.
- Kept the minimum VS Code engine requirement at `^1.120.0`.
- Build output now packages the `frontagent-2.1.1.vsix` artifact through the root `pnpm build` script.

## 2.1.0

- Added release alignment with the FrontAgent `2.1.0` CLI and runtime packages.
- Added the Open Memory Gateway-backed runtime capabilities exposed through the shared `@frontagent/runtime-node` integration.
- Updated the extension package for the OSS Harness release train and current runtime dependency set.
- Raised the minimum VS Code engine requirement to `^1.120.0`.
- Build output now packages the `frontagent-2.1.0.vsix` artifact through the root `pnpm build` script.

## 2.0.0

- Shipped the major FrontAgent 2.0 architecture refactor with focused runtime, agent, executor, LLM, context, memory, and VS Code modules.
- Kept the VS Code extension version aligned with the root `frontagent` package.

## 1.0.4

- Deferred Playwright loading until browser tools are actually used, so the FrontAgent runtime can load in the VS Code extension without a local Playwright install.

## 1.0.3

- Added FrontAgent extension logs through a dedicated output channel.
- Deferred runtime loading until a command or chat run needs it, so commands can register even if the runtime fails later.
- Added `frontagent.apiKey` as a settings fallback while keeping SecretStorage as the recommended storage path.

## 1.0.2

- Fixed extension activation by bundling the extension host entry as CommonJS.
- Fixed the Activity Bar icon path with a dedicated monochrome SVG icon.
- Reworked the sidebar into a chat-first FrontAgent experience.
- Changed LLM settings defaults to stay empty and rely on settings, secrets, or environment variables.

## 1.0.1

- Updated Marketplace README to describe the VS Code extension workflow.
- Documented the two supported FrontAgent usage modes: CLI and VS Code.

## 0.1.0

- Initial VS Code sidebar task console for FrontAgent.
- Added run, cancel, approval, SDD init/validate, configuration, and run log commands.
