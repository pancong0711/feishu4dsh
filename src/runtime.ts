/**
 * Runtime boundary and Cordis activation for the plugin.
 * @module feishu4dsh/runtime
 */

import { createRequire } from 'node:module'
import type { Context } from '@deepseek-ai/cordis'
import { Config, resolveConfig, hasCredentials } from './config.js'
import type { ResolvedConfig } from './config.js'
import { resolveAuthorization, describeAuthorization } from './acl.js'
import { createFeishuPort } from './adapter.js'
import { installBridge, type BridgeHost, type BridgeHooks } from './bridge.js'

/** Resolved configuration whose credentials are present. */
export type ChannelConfig = ResolvedConfig

/** The running plugin version, logged at bootstrap so operators can confirm
 * WHICH build a deployment serves (ops lesson 2026-08-28: a restarted service
 * is not by itself proof that the new build is live). */
const pluginVersion: string = (createRequire(import.meta.url)('../package.json') as { version?: string }).version ?? 'unknown'

/** Substitutable production boundaries; tests replace them with fakes. */
export const internals: {
  notify: (line: string) => void
} = {
  // Stamped lines: the operator console answers WHEN something happened, so
  // every line carries its own timestamp.
  notify: line => void process.stderr.write(`[${new Date().toLocaleString('sv-SE')}] ${line}\n`),
}

/**
 * Apply the plugin to its Cordis context. With credentials configured the
 * transport connects directly and the bridge starts; without them the
 * operator gets a console note pointing at the configuration, and nothing
 * half-started is left listening.
 * @param ctx - Scoped plugin context; requires the `agents` service.
 * @param config - Configuration resolved by Cordis from the exported schema.
 */
export function apply(ctx: Context, config: Config): void {
  let active = true
  ctx.effect(() => () => { active = false }, 'feishu:lifetime')

  const bootstrap = async (): Promise<void> => {
    internals.notify(`feishu4dsh: plugin v${pluginVersion} bootstrap (pid ${process.pid})`)
    // Loader siblings mount concurrently; wait for the complete application
    // so a first message never sees a half-grown agent world.
    const loader = ctx.get('loader') as { await(): Promise<unknown> } | undefined
    if (loader !== undefined) await loader.await().catch(() => undefined)
    if (!active) return

    let resolved = resolveConfig(config)

    // Durable state flows through the settings section when one is composed;
    // this channel keeps only the entry config otherwise. A workspace chosen
    // via /cd is written back here so it survives a restart.
    let settingsScope: { get(): unknown; update(patch: object): Promise<unknown> } | undefined
    const settings = ctx.get('settings') as {
      register(ns: string, schema: unknown, options?: { base?: unknown }): { get(): unknown; update(patch: object): Promise<unknown> }
    } | undefined
    if (settings !== undefined) {
      try {
        settingsScope = settings.register('feishu4dsh', Config, { base: config })
        resolved = resolveConfig(settingsScope.get() as Config)
      } catch (error) {
        ctx.logger('feishu4dsh').warn(
          'settings registration failed; continuing with entry config only: %s',
          error instanceof Error ? error.message : error,
        )
      }
    }

    if (!hasCredentials(resolved)) {
      internals.notify(
        'feishu4dsh: no appId/appSecret configured — set FEISHU_APP_ID / '
        + 'FEISHU_APP_SECRET (see docs/FEISHU-SETUP.md); the channel stays offline.',
      )
      return
    }

    const authorization = resolveAuthorization(resolved)
    internals.notify(describeAuthorization(authorization))

    const port = createFeishuPort(resolved, authorization, internals.notify)
    const host: BridgeHost = {
      agents: ctx.agents,
      on: (name, listener) => (ctx.on as (name: string, listener: (...args: never[]) => unknown) => unknown)(name, listener),
      get: name => ctx.get(name),
    }
    const hooks: BridgeHooks = {
      // Persist one chat's /cd selection so it survives restarts. The patch
      // deep-merges, so only the changed key is written.
      onWorkspaceChange: settingsScope === undefined
        ? undefined
        : async (scopeKey, workspacePath) => {
            await settingsScope.update({ chatWorkspaces: { [scopeKey]: workspacePath } })
          },
      // Persist the list of /ws-added workspaces so it survives restarts.
      onUserWorkspacesChange: settingsScope === undefined
        ? undefined
        : async (workspaces) => {
            await settingsScope.update({ userWorkspaces: workspaces })
          },
      // Persist the /model picker catalog so add/del/learning survive restarts (R33).
      onModelCatalogChange: settingsScope === undefined
        ? undefined
        : async (entries) => {
            await settingsScope.update({ modelCatalog: entries })
          },
      // Persist one scope's /mode preset override so it survives restarts (R27).
      onPresetChange: settingsScope === undefined
        ? undefined
        : async (scopeKey, preset) => {
            await settingsScope.update({ chatPresets: { [scopeKey]: preset } })
          },
      // Persist the per-model reasoning-effort preference table (R28).
      onModelEffortsChange: settingsScope === undefined
        ? undefined
        : async (efforts) => {
            await settingsScope.update({ modelEfforts: efforts })
          },
      // Persist the session registry + active-generation pointers (R29).
      onSessionsChange: settingsScope === undefined
        ? undefined
        : async ({ sessions, activeGen }) => {
            await settingsScope.update({ chatSessions: sessions, chatActiveGen: activeGen })
          },
    }
    const disposeBridge = installBridge(host, resolved, port, authorization, internals.notify, hooks)

    try {
      await port.connect()
      const identity = port.botIdentity
      internals.notify(
        identity === undefined
          ? 'feishu4dsh: connected'
          : `feishu4dsh: connected as ${identity.name} (${identity.openId})`,
      )
    } catch (error) {
      ctx.logger('feishu4dsh').error(
        'transport connect failed: %s',
        error instanceof Error ? error.message : error,
      )
      void disposeBridge().catch(() => undefined)
      return
    }

    ctx.effect(() => async () => {
      await disposeBridge()
      await port.disconnect().catch(() => undefined)
    }, 'feishu:teardown')
  }

  void bootstrap().catch(error => {
    ctx.logger('feishu4dsh').error(
      'bootstrap failed: %s',
      error instanceof Error ? error.message : error,
    )
  })
}
