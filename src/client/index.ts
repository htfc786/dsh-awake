/**
 * dsh-awake —— 浏览器半入口（window.__ModuleLoader__ bundle）。
 *
 * 注册「插件列表 → 插件详情 → dsh-awake」配置面板（plugins.bundle.config，
 * DESIGN.md 4.1）+ 后台浏览器 Wake Lock 驱动（2.3，跟随会话列表 running 汇总；
 * 开关走 localStorage）。设置页（settings.section）已退役：不再向 DSH 设置面板
 * 注册任何 slot。
 *
 * 数据面走 POST /api/dsh-awake（见 src/types.ts 的线格式）：
 *   - awake.status / awake.refresh / awake.select / awake.version /
 *     awake.update / awake.restart
 *
 * 本文件由 tsdown 打包为 ModuleLoader 工厂形态（banner/intro/footer 由
 * tsdown.client.config.ts 拼装），源码里可以正常使用 import/JSX。
 */
import { makeRpc } from './api.js'
import { AwakeSection } from './components/AwakeSection.js'
import { en, zh } from './locales.js'
import { SELF_PACKAGE_NAME } from './self.js'
import { PLUGIN_ID, SETTINGS_LOCALE_NS } from '../shared/constants.js'
import type { ClientContext } from './types.js'
import { isWebWakeLockEnabled, WakeLockManager } from './wake-lock.js'

/** 插件包名（= ModuleLoader 条目 id）。 */
export const name = PLUGIN_ID

/**
 * 依赖的客户端服务（slots / sessions / locale 均为 DSH 平台模块）。
 * 数据面走同源 fetch（/api/dsh-awake），不再需要 connection 客户端服务。
 */
export const inject = ['slots', 'sessions', 'locale']

/** 装配入口：注册设置页 + 后台 Wake Lock 驱动。 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(SETTINGS_LOCALE_NS)
  // 注意：ctx.effect 的 callback 会立即执行，其返回值才是卸载时的清理函数——
  // 绝不能在这里直接调用 disposeLocale()（会立刻注销字典，t 随即失效）。
  const disposeLocale = ctx.locale.register(SETTINGS_LOCALE_NS, { zh, en })

  // 样式标签以 data-plugin 标记（loader 卸载时会清理插件拥有的标签，其 id 即 npm
  // 包名）；这里再兜底一个 effect：卸载时移除本插件名下的所有 <style>。
  const removeOwnedStyles = (): void => {
    for (const tag of document.querySelectorAll(`style[data-plugin="${SELF_PACKAGE_NAME}"]`)) {
      tag.remove()
    }
  }
  ctx.effect(
    () => () => {
      disposeLocale()
      removeOwnedStyles()
    },
    `${PLUGIN_ID}: locale + style cleanup`,
  )

  // —— 后台浏览器 Wake Lock 驱动（2.3，无 UI）——
  const manager = new WakeLockManager()
  manager.setEnabled(isWebWakeLockEnabled())

  // ctx.sessions：跟随「是否有任务在运行」的 running 汇总申请/释放 Wake Lock。
  const syncRunning = (): void => {
    const list = ctx.sessions.list.getSnapshot()
    const anyRunning = Object.values(list.byId).some((summary) => summary.running)
    manager.setTaskActive(anyRunning)
  }
  const unsubscribeSessions = ctx.sessions.list.subscribe(syncRunning)
  syncRunning()

  ctx.effect(
    () => () => {
      unsubscribeSessions()
      manager.dispose()
    },
    `${PLUGIN_ID}: wake lock driver`,
  )

  // —— 插件列表 → 插件详情 → dsh-awake（plugins.bundle.config）——
  // 配置渲染在本插件于插件管理页的详情页（「插件列表 → dsh-awake」），位于包描述
  // 与组件行之间。该 keyed slot 以包名为 key，且页面只在注册了与**安装名**相同的
  // key 时才渲染配置区块（dsh-client-ui-plugin-manager: `configured = ledger.bundles
  // .has(openPkg.name)`；openPkg.name 是 profile 依赖 / dsh.profile.bundles 的条目名）。
  // key 取构建期注入的 SELF_PACKAGE_NAME（= package.json 的 name），因此只有当
  // 「package.json.name == cordis.patch.yml 的 insert name == 安装名」时才命中；
  // 硬编码或 alias 安装都会失配（alias 下 Loader 行名 ≠ manifest name，客户端半被
  // dsh-client-modules 静默跳过）——详见 self.ts。bundle 页只请求 view:'page' 且不传
  // 宿主 form——草稿/校验/保存由本插件自持，走 /api/dsh-awake 数据面。
  // settings.section 已退役，DSH 设置面板不再出现本插件。
  const api = makeRpc()
  ctx.slots.inject('plugins.bundle.config', () =>
    ctx.slots.register(
      {
        name: 'plugins.bundle.config',
        key: SELF_PACKAGE_NAME,
        locale: SETTINGS_LOCALE_NS,
        inject: () => ({ api, manager, t }),
      },
      AwakeSection,
    ),
  )
}
