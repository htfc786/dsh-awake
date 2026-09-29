/**
 * AwakeService：host 半编排器（构造即装配，仿 WinMgrService）——
 *   1. 探测平台 + 注册表；
 *   2. AwakeCoordinator（引用计数 + 回退链）；
 *   3. settings 命名空间（可选服务；缺席退回入口配置，只读）；
 *   4. 设置页数据面 POST /api/dsh-awake（可选服务；缺席则设置页数据面停用）；
 *   5. 会话生命周期事件 + 卸载放锁。
 */
import { CONFIG_VERSION, PLUGIN_ID } from '../shared/constants.js'
import type { AwakeStatus, ModeInfo, ModeTestResult, SelectResponse } from '../types.js'
import { detectPlatform, normalizeConfig, registryFor, type ModeSession, type PlatformRegistry, type WakeMode } from '../modes/index.js'
import { errorMessage } from '../modes/shared/tools.js'
import { AwakeCoordinator } from './coordinator.js'
import { getOptionalService, type HostContext, type ResolvedConfig } from './context.js'
import { installAwakeRpc } from './rpc.js'
import { restartHost } from './restart.js'
import { AwakeSettings, type ParsedAwakeSettings } from './settings.js'
import { createUpdateHelper } from './update.js'
import { versionInfo } from './version.js'

/** 探测缓存：方式 id → 结果（refresh 时失效）。 */
interface ProbeCacheEntry {
  readonly ok: boolean
  readonly reason: string | null
}

export class AwakeService {
  private readonly registry: PlatformRegistry | undefined
  private readonly desktop: boolean
  private readonly coordinator: AwakeCoordinator
  private readonly settings: AwakeSettings
  private readonly probeCache = new Map<string, ProbeCacheEntry>()
  /** 常开防休眠：纯内存状态（不写配置文件，宿主重启即失效，设置页每次用时再开）。 */
  private alwaysOn = false

  constructor(ctx: HostContext, config: ResolvedConfig = {}) {
    const platform = detectPlatform()
    this.registry = registryFor(platform)
    // 桌面端环境识别（官方兼容模式）：desktopProfiles / desktopPnpm 只在
    // DSH Desktop（Electron）里存在；更新/重启在此环境关闭。
    this.desktop =
      getOptionalService(ctx, 'desktopProfiles') !== undefined || getOptionalService(ctx, 'desktopPnpm') !== undefined

    let settingsRef!: AwakeSettings
    this.coordinator = new AwakeCoordinator({
      registry: this.registry,
      resolve: () => {
        const parsed: ParsedAwakeSettings = settingsRef.snapshot
        return { modeId: parsed.modeId, config: parsed.config, alwaysOn: this.alwaysOn }
      },
      logger: ctx.logger,
    })
    // 配置读取走 apply 收到的 config 引用树（live 字段 volatile，就地更新）。
    settingsRef = new AwakeSettings(ctx, () => config, () => this.coordinator.reconcile(), ctx.logger)
    this.settings = settingsRef
    settingsRef.attach()

    // 会话生命周期：跨会话引用计数（turn/start 0→1 拿锁，turn/end 1→0 放锁）。
    ctx.on('session/event', (_session: unknown, event: unknown) => {
      const type = (event as { type?: unknown } | null)?.type
      if (typeof type === 'string') this.coordinator.onSessionEvent({ type })
    })

    // 插件卸载（热重载 / 退出）时无条件放锁。
    ctx.effect(
      () => () => {
        void this.coordinator.dispose()
      },
      `${PLUGIN_ID}: 卸载放锁`,
    )

    // RPC 数据面（可选服务；connection 缺席时设置页停用，服务端照常值守）。
    // 用 ctx.inject 等 connection 出现再注册：它是 web 专属服务，headless / tui
    // 档位没有，所以不能写进插件 export inject（那样条目会一直 pending，
    // 整棵加载树在 assertEntriesActivated 里报 "did not activate"）。
    ctx.inject(['connection'], (rpcCtx) => {
      const connection = rpcCtx.connection
      if (connection?.fetch?.register === undefined) {
        ctx.logger.warn(`[${PLUGIN_ID}] Connection 服务不可用，设置页数据面停用（服务端照常值守）`)
        return
      }
      installAwakeRpc(connection, {
        service: this,
        desktop: this.desktop,
        runUpdate: createUpdateHelper(),
        restart: () => restartHost(),
        logger: ctx.logger,
      })
    })

    const status = this.status()
    ctx.logger.info(
      `[${PLUGIN_ID}] 已启动：platform=${status.platform} mode=${status.selected ?? 'off'}（默认 ${this.registry?.defaultMode ?? '—'}），` +
        `stale=${status.stale}，desktop=${this.desktop}，版本 ${status.version.loaded}`,
    )
  }

  /** 状态 + 方式列表 + 可用性 + 版本。 */
  status(): AwakeStatus {
    const parsed = this.settings.snapshot
    return {
      platform: detectPlatform(),
      selected: parsed.modeId,
      effective: this.coordinator.effectiveMode,
      active: this.coordinator.isActive,
      openTurns: this.coordinator.openTurnCount,
      stale: parsed.stale,
      alwaysOn: this.alwaysOn,
      configured: { platform: parsed.configuredPlatform, mode: parsed.configuredMode },
      attempts: [...this.coordinator.attemptLog],
      modes: this.modeInfos(),
      config: parsed.config,
      version: versionInfo(),
      desktop: this.desktop,
    }
  }

  /**
   * 常开防休眠开关（设置页一键开关）：纯内存状态，不写配置文件，宿主重启即失效。
   * 开启 → 立即对账拿锁（无任务也值守）；关闭 → 无任务时放锁。
   * 开启时若当前方式为 off（服务端不值守）→ 拒绝并给出提示。
   */
  async setAlwaysOn(enabled: boolean): Promise<AwakeStatus> {
    if (enabled && this.settings.snapshot.modeId === null) {
      throw new Error('当前插件运行模式为「关闭（off）」，请先选择一种方式再开启常开防休眠')
    }
    this.alwaysOn = enabled
    // 对账：常开开启 → 立即拿锁；关闭且无任务 → 放锁。
    await this.coordinator.reconcile()
    await this.coordinator.drain()
    return this.status()
  }

  /** 失效可用性缓存重新探测（刷新按钮）。 */
  refresh(): AwakeStatus {
    this.probeCache.clear()
    return this.status()
  }

  /**
   * 写配置：normalize → configEditor 整段写回（避免深合并残留旧 config 键）→
   * 重读实时配置 + 对账（openTurns > 0 时先放锁再按新配置拿锁）+ 试运行。
   */
  async select(mode: string, config: Record<string, unknown>): Promise<SelectResponse> {
    const platform = detectPlatform()
    if (platform === 'unsupported') throw new Error('当前平台不受支持')
    const writer = this.settings.writer
    if (writer === null) throw new Error('配置写入不可用（configEditor 缺席，只读）')
    if (mode !== 'off') {
      const registry = registryFor(platform)
      const target = registry?.modes[mode]
      if (target === undefined) throw new Error(`方式 ${mode} 在当前平台不可用`)
      const normalized = normalizeConfig(target.fields, config)
      await writer({ version: CONFIG_VERSION, platform, mode, config: normalized })
    } else {
      await writer({ version: CONFIG_VERSION, platform, mode: 'off', config: {} })
    }
    // 写入后重读实时配置（volatile 引用由 loader 就地更新）→ 对账；等链排空，
    // 让响应反映最新生效状态。
    this.settings.reload()
    await this.coordinator.reconcile()
    await this.coordinator.drain()
    const status = this.status()
    // 应用后测试方案是否可用（start→stop 冒烟；off / 有任务运行 / 平台不支持时跳过）。
    const test = await this.smokeTest(mode, config)
    return { status, test }
  }

  /** 试运行：start → isActive 确认 → stop（幂等清理）。失败返回原因，不抛出。 */
  private async smokeTest(mode: string, rawConfig: Record<string, unknown>): Promise<ModeTestResult | null> {
    const platform = detectPlatform()
    if (platform === 'unsupported' || mode === 'off') return null
    // 有任务运行：对账已真实拿锁，无需（也不应）再试运行。
    if (this.coordinator.openTurnCount > 0) return null
    const target = registryFor(platform)?.modes[mode]
    if (target === undefined) return null

    const probe = target.isAvailable()
    if (!probe.ok) return { ok: false, reason: probe.reason }
    const config = normalizeConfig(target.fields, rawConfig)
    let session: ModeSession | null = null
    try {
      session = await target.start(config)
      if (!session.isActive()) {
        return { ok: false, reason: '方式启动后未保持运行' }
      }
      return { ok: true, description: session.description }
    } catch (error) {
      return { ok: false, reason: errorMessage(error) }
    } finally {
      if (session !== null) {
        try {
          await session.stop()
        } catch {
          // 清理失败不掩盖试运行结果
        }
      }
    }
  }

  /** 当前平台全部方式的 ModeInfo（可用性走缓存）。 */
  private modeInfos(): ModeInfo[] {
    if (this.registry === undefined) return []
    return this.registry.order.map((id) => {
      const mode = this.registry!.modes[id]!
      const probe = this.probe(id, mode)
      return {
        id,
        name: mode.name,
        description: mode.description,
        default: mode.default,
        available: probe.ok,
        reason: probe.ok ? null : probe.reason,
        fields: mode.fields,
      }
    })
  }

  private probe(id: string, mode: WakeMode): ProbeCacheEntry {
    const cached = this.probeCache.get(id)
    if (cached !== undefined) return cached
    const result = mode.isAvailable()
    const value: ProbeCacheEntry = result.ok ? { ok: true, reason: null } : { ok: false, reason: result.reason }
    this.probeCache.set(id, value)
    return value
  }
}
