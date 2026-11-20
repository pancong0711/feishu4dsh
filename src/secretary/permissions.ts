/**
 * Fixed permission baseline for SHE executor sessions.
 *
 * The action names and matching semantics below were verified against the
 * running OpenCode 2.3.2 HttpApi on 2026-11-19:
 * - `shell` resources are the literal command string (glob-shaped), and
 *   patterns such as `*git commit*` are enforced;
 * - `external_directory` only gates file-oriented tools (read/write/edit),
 *   NOT shell commands;
 * - `read` patterns such as `*.env` gate the `read` tool, NOT `cat` via shell.
 *
 * Therefore this ruleset is defense-in-depth against mistakes, not an OS
 * sandbox. Strong write confinement requires running OpenCode under a
 * dedicated user/container/namespace with writable access to the topic
 * worktree only.
 * @module feishu4dsh/secretary/permissions
 */

import type { ExecutorPermissionRule } from './types.js'

/** Default rules: task worktree writes allowed, dangerous tools/commands denied. */
export const SHE_PERMISSION_RULES: readonly ExecutorPermissionRule[] = [
  { action: '*', resource: '*', effect: 'allow' },
  // File tools may not leave the session location (shell is handled separately).
  { action: 'external_directory', resource: '*', effect: 'deny' },
  { action: 'webfetch', resource: '*', effect: 'deny' },
  { action: 'websearch', resource: '*', effect: 'deny' },
  // OpenCode's real action id is `subagent`; keep `task` for older versions.
  { action: 'subagent', resource: '*', effect: 'deny' },
  { action: 'task', resource: '*', effect: 'deny' },
  // File-tool credential reads. Shell is not covered by these patterns.
  { action: 'read', resource: '*.env', effect: 'deny' },
  { action: 'read', resource: '*.env.*', effect: 'deny' },
  { action: 'read', resource: '*.pem', effect: 'deny' },
  { action: 'read', resource: '*.key', effect: 'deny' },
  // Shell command denials. These are literal/glob matches on the full command
  // string and can be bypassed by obfuscation; they are not a security sandbox.
  { action: 'shell', resource: '*sudo *', effect: 'deny' },
  { action: 'shell', resource: '*rm -rf *', effect: 'deny' },
  { action: 'shell', resource: '*git commit*', effect: 'deny' },
  { action: 'shell', resource: '*git push*', effect: 'deny' },
  { action: 'shell', resource: '*git merge*', effect: 'deny' },
  { action: 'shell', resource: '*git reset --hard*', effect: 'deny' },
  { action: 'shell', resource: '*git clean *', effect: 'deny' },
  { action: 'shell', resource: '*npm install*', effect: 'deny' },
  { action: 'shell', resource: '*npm i *', effect: 'deny' },
  { action: 'shell', resource: '*pnpm add*', effect: 'deny' },
  { action: 'shell', resource: '*yarn add*', effect: 'deny' },
]
