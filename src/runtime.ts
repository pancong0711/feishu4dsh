/**
 * Runtime boundary and Cordis activation for the plugin.
 * @module feishu4dsh/runtime
 */

import { createRequire } from 'node:module'
import type { Context } from '@deepseek-ai/cordis'
import { Config, resolveConfig, hasCredentials } from './config.js'

/**
 * R44: the durable-state write seam for dsh 0.2.0. A plugin's settings section
 * IS its profile-patch entry config; writes go through `settings.update(ns,
 * patch)` and only `volatile`-marked paths are accepted (the marker lives in
 * `src/config.ts`). The old 0.1.5 `settings.register(ns, schema, { base })` is
 * gone — calling it threw a TypeError only a cordis logger saw (invisible to
 * journald), which silently disabled every persistence hook. Returns a
 * bridge-facing scope or `undefined`, and notifies ONCE when unusable.
 */
export function buildSettingsScope(
  settings: { update(ns: string, patch: object, expectedRevision?: string): Promise<unknown> } | undefined,
  notify: (line: string) => void,
  ns = 'feishu4dsh',
): { update(patch: object): Promise<unknown> } | undefined {
  if (settings === undefined || typeof settings.update !== 'function') {
    notify(
      'feishu4dsh: settings 服务不可用（宿主缺 settings.update API）— '
      + '运行态持久化已禁用：/mode、/model 清单与推理强度、会话注册表的改动重启即丢。',
    )
    return undefined
  }
  return { update: patch => settings.update(ns, patch) }
}

import type { ResolvedConfig } from './config.js'
import { resolveAuthorization, describeAuthorization } from './acl.js'
import { createFeishuPort } from './adapter.js'
import { installBridge, type BridgeHost, type BridgeHooks } from './bridge.js'
import { resolveLocale, strings } from './strings.js'

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

    // Durable state flows through the settings service when one is composed;
    // this channel keeps only the entry config otherwise. A workspace chosen
    // via /cd is written back here so it survives a restart.
    //
    // R44 (dsh 0.2.0): the old `settings.register(ns, schema, { base })` seam is
    // GONE — in 0.2.0 a plugin's settings section IS its profile-patch entry
    // config (validated against the entry's own `Config` schema by the settings
    // service), and writes go through `settings.update(ns, patch)`, which only
    // accepts `volatile`-marked config paths. Registration used to fail with a
    // TypeError that only a cordis logger saw (invisible to journald), silently
    // disabling EVERY persistence hook — /mode's switch, the session registry,
    // the effort table all died with the restart. Reads now come from the entry
    // config directly; the volatile fields are marked in `src/config.ts`.
    const settings = ctx.get('settings') as {
      update(ns: string, patch: object, expectedRevision?: string): Promise<unknown>
    } | undefined
    const settingsScope = buildSettingsScope(settings, internals.notify)

    if (!hasCredentials(resolved)) {
      internals.notify(
        'feishu4dsh: no appId/appSecret configured — set FEISHU_APP_ID / '
        + 'FEISHU_APP_SECRET (see docs/FEISHU-SETUP.md); the channel stays offline.',
      )
      return
    }

    const authorization = resolveAuthorization(resolved)
    internals.notify(describeAuthorization(authorization))

    // R36: the streaming placeholder is user-facing copy — resolve it from the
    // shared strings table here and hand it to the transport, so the adapter
    // never hard-codes text (and never falls back to the SDK's English default).
    const streamInitialText = strings(resolveLocale(resolved.locale)).streamInitial
    const port = createFeishuPort(resolved, authorization, internals.notify, streamInitialText)
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
      // Persist one scope's /reasoning display override (R36 stage two).
      onReasoningChange: settingsScope === undefined
        ? undefined
        : async (scopeKey, choice) => {
            await settingsScope.update({ chatReasoning: { [scopeKey]: choice } })
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
