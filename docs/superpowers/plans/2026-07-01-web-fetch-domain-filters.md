# Web Fetch Domain Filters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose Anthropic-compatible `allowed_domains` and `blocked_domains` parameters on the `web_fetch` MCP tool and route them to the existing engine host filters.

**Architecture:** Keep enforcement in the existing URL safety and fetch engine path. Extend only the MCP schema and handler adapter so `allowed_domains` maps to `allowHosts` and `blocked_domains` maps to `denyHosts`.

**Tech Stack:** TypeScript, Vitest, existing `@frontagent/mcp-web-fetch` package.

---

### Task 1: Add Schema and Handler Coverage

**Files:**
- Modify: `packages/mcp-web-fetch/src/tools.security.test.ts`

- [x] **Step 1: Add schema assertions**

Import `webFetchSchema` and `vi`, then add tests asserting the schema exposes `allowed_domains` and `blocked_domains` as optional string arrays.

- [x] **Step 2: Add handler no-network assertions**

Patch `globalThis.fetch` with a throwing mock for each domain-filter test, call `handleWebFetchTool('web_fetch', ...)`, assert the result fails with allow/block wording, and assert the fetch mock was not called.

- [x] **Step 3: Run focused test and confirm failure before implementation**

Run: `pnpm --dir packages/mcp-web-fetch test -- --run src/tools.security.test.ts`

Expected before implementation: schema/domain-filter tests fail because schema fields are missing and handler does not pass filters to the engine.

### Task 2: Map Tool Parameters to Engine Options

**Files:**
- Modify: `packages/mcp-web-fetch/src/tools.ts`

- [x] **Step 1: Extend `webFetchSchema`**

Add optional `allowed_domains` and `blocked_domains` properties with `type: 'array'`, string `items`, and descriptions noting their mapping to `allowHosts` and `denyHosts`.

- [x] **Step 2: Extend `handleWebFetchTool`**

Pass `allowHosts: args.allowed_domains as string[] | undefined` and `denyHosts: args.blocked_domains as string[] | undefined` to `fetchUrl`.

- [x] **Step 3: Run focused tests**

Run: `pnpm --dir packages/mcp-web-fetch test -- --run src/tools.security.test.ts`

Expected after implementation: all tests in `tools.security.test.ts` pass.

### Task 3: Verify and Prepare PR

**Files:**
- No additional planned code files.

- [x] **Step 1: Run mcp-web-fetch package tests**

Run: `pnpm --dir packages/mcp-web-fetch test`

Expected: package test suite passes.

- [x] **Step 2: Run required broader gate**

Run: `pnpm quality:precommit`

Expected: lint, typecheck, test, and workflow tests pass.

- [x] **Step 3: Run GitNexus final diff analysis**

Run GitNexus `detect_changes` for `/tmp/frontagent-issue-380` before committing and include the blast radius summary in the PR body.

- [ ] **Step 4: Commit, push, and open PR**

Commit with a focused message, push `feat/web-fetch-domain-filters-380`, and open a PR to `develop` with `Closes #380`.
