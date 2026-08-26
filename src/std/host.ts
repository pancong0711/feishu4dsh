/**
 * dsh-std Community v0.15 standard entry (host facet). Declared by
 * `dsh-plugin.json` → `facets.host.entry` as `lib/std/host.js`; it is loaded
 * only by hosts that activated `@dsh-std/adapter-dsh`. Dual-track discipline:
 * the legacy `cordis.patch.yml` path keeps driving `../runtime.js` directly,
 * so both entries always execute the same business code.
 *
 * ⚠️ 实际激活契约（context 形状、config 投影方式）以 R19-b spike 实测为准，
 * 本文件仅为阶段 1 占位接线：唯一职责是把标准入口委托给 legacy 的
 * `../runtime.js#apply`。纪律（由 scripts/check-manifest.mjs 与
 * tests/std-manifest.spec.ts 把关）：≤80 行、零业务逻辑、不 import 任何
 * 宿主包（@deepseek-ai/*）、相对导入带 .js 后缀。
 *
 * 注：清单 `requires.contracts` 暂留空数组——待 R19-b spike 实测 adapter-dsh
 * 发布的 support 清单后回填（v0.15 schema 允许省略/为空）。
 */

import type { Config } from '../config.js'
import { apply } from '../runtime.js'

/**
 * Activation context shape, derived structurally from the runtime signature
 * so this std-layer module never imports a host package directly.
 */
type ActivationContext = Parameters<typeof apply>[0]

/**
 * Standard facet activation: a dsh-std host invokes the default export once
 * per activation. Config resolution reuses the existing {@link Config}
 * pipeline — an omitted projection falls back to schema defaults downstream.
 * @param context - host-provided activation context (shape: R19-b spike).
 * @param config - plugin configuration projection; defaults to `{}`.
 */
export default function activate(context: ActivationContext, config: Config = {}): void {
  apply(context, config)
}
