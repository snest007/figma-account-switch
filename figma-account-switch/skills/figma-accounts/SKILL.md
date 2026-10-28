---
name: figma-accounts
description: Open the Figma Accounts panel and manage independent Figma MCP accounts in Codex. Use for adding accounts, switching the default account, checking authentication, or repairing a Figma login.
---

# Figma Accounts

Use the local Figma Accounts plugin for account management. All fixed actions run locally through Codex's OAuth and configuration interfaces; they never invoke a language model. Any conversational reasoning must keep the user's existing Codex model provider and gateway. Never add a direct model endpoint, API key, or an independent model client.

## Open the interface

1. Call this plugin's `open_accounts_panel` tool.
2. If the embedded panel is visible, use it. If the host does not render it, open the returned `panelUrl` with `mcp__codex_app__open_in_codex` as a browser target in the current task.
3. If the tool is not loaded yet, run `node scripts/panel.mjs` from this installed plugin's root (resolve relative to this skill's location: `../..`). Open its returned URL in the Codex browser. Do not open an unrelated Figma design file.

The page contains actual account state and fixed actions. OAuth authorization is completed by the user in Figma's official browser page. The plugin must not ask the user to paste passwords or tokens.

## Manage accounts

- `list_accounts`: read aliases, verified identity, enabled state, hosted-connector conflict, and current provider origin.
- `manage_account(action="use", data={alias})`: the preferred account-selection flow. It checks the selected connection's identity and configures the default. If authorization is missing, it starts native OAuth and completes the selection after the user authorizes the correct account. A user-requested retry after a wrong-account authorization can reopen OAuth. Do not start this flow without the user's account choice.
- `manage_account(action="add", data={label})`: create a disabled, independent official Figma MCP connection. Then offer/start `login` for the returned alias when the user requests authorization.
- `login`: launch Codex's native OAuth flow for one alias. The browser may be signed into the wrong account; rely on the returned verified identity, never the user's label.
- `verify`: check identity with `whoami` in an isolated, ephemeral MCP diagnostic context. This starts no model turn. It does not prove an already-open desktop task changed identity.
- `select`: checks identity before configuring the global default for new connections; it can affect other Codex clients using the same host config. It must not interrupt running tasks. For either `use` or `select`, if a hosted-connector conflict is returned, describe it and obtain the user's explicit choice to stop using that connector before passing `takeOverHosted: true`.
- `rename`: update the display label without changing the internal connection name or credentials.
- `cancel`: cancel a pending OAuth job.
- `restore`: restore only the enable flags from the previous switch. It refuses to overwrite subsequent changes to those flags.

## Verify the desktop task

The panel deliberately separates connection authorization from desktop task identity. After switching, use a new task when runtime reload has not been demonstrated. In that task, call `whoami` on the exact custom alias selected by the user. Do not use `mcp__codex_apps__figma_whoami` to verify a custom alias: that tool belongs to the separate hosted connector.

Never claim "account switched in this task" from a successful config write or the plugin's isolated `verify` result. Report these separately:

- Default connection configured.
- Account authorization verified.
- Current desktop task identity verified, only if its own exact-alias tool call returned the expected identity.

Do not clear conversation history or assume old file links and node IDs belong to the new account. Re-read target files under the new account before design operations.

## Boundaries

This plugin manages custom connections to `https://mcp.figma.com/mcp`. It cannot replace the OAuth login of the hosted Figma connector. Switching may disable that connector's tools while keeping the plugin installed. Do not promise hosted skills or all write-to-canvas tools are identical; inspect the custom connection's actual tool inventory.

The service binds only to `127.0.0.1`. Its runtime URL includes a local session capability; do not put it in public issues, source files, screenshots, or shared reports. Figma OAuth credentials remain in Codex's credential storage. The plugin stores only labels, aliases, verified identities, and a narrow switch journal in the user's application-support directory.
