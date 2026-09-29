/**
 * 插件配置（DSH 0.1.7 模型：插件 Config schema + configEditor）。
 *
 * 0.1.7 起，dsh-settings 的旧 API（register/get/update/replace 命名空间）已移除，
 * 设置改为「插件自己的 Config」单一层：apply(ctx, config) 收到解析后的 config 引用树
 * （live 字段 .volatile() → config.<field>.get() 读实时值；loader 的 _commitVolatile
 * 在设置写入时就地更新引用，不重启插件）。写入走 configEditor.edit(entry, updater)，
 * 持久化到当前 profile 的插件配置。
 *
 * 本文件保留与旧版一致的语义：
 *   - 宽松形状：`{ version, platform, mode, config: 任意对象 }`——config 键由方式声明；
 *   - stale 检测（跨平台复制 / 实现被删，见 parseSettings）；
 *   - 老版（0.1.x）配置自动迁移（enabled/shellWakeLock/powerCfgWakeLock/why → 新形状），
 *     识别原始 config 后一次写回；
 *   - 设置变更（loader/volatile-update）触发重新解析 + 协调器对账。
 */
import { CONFIG_VERSION, PLUGIN_ID } from '../shared/constants.js'
import type { AwakeSettingsShape } from '../types.js'
import { detectPlatform, powerModes, registryFor, type PlatformId } from '../modes/index.js'
import { errorMessage } from '../modes/shared/tools.js'
import type { ConfigEditorService, HostContext, LoggerLike } from './context.js'

/** 解析后的配置快照（stale 兜底已应用）。 */
export interface ParsedAwakeSettings {
  /** 运行时采用的方式；null = 关闭（off）/ 平台不支持。 */
  readonly modeId: string | null
  /** 配置来自其他平台 / 方式失效（解析兜底，不覆盖文件）。 */
  readonly stale: boolean
  /** 配置的平台锚点原文。 */
  readonly configuredPlatform: string | null
  /** 配置的方式原文。 */
  readonly configuredMode: string | null
  /** 该方式的配置（宽松对象，键由方式声明）。 */
  readonly config: Record<string, unknown>
}

/** 0.1.x 旧配置形状判定（顶层键存在即视为旧配置）。 */
export function isLegacyShape(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return 'enabled' in v || 'shellWakeLock' in v || 'powerCfgWakeLock' in v || 'webWakeLock' in v || 'why' in v
}

/** 一个 volatile 引用（.get() 读实时值）——loader _commitVolatile 就地更新。 */
function isConfigRef(value: unknown): value is { get(): unknown } {
  return typeof value === 'object' && value !== null && typeof (value as { get?: unknown }).get === 'function'
}

/**
 * 把 apply(ctx, config) 收到的解析后 Config（live 字段为 volatile 引用）摊平成普通对象。
 * 未知键（未迁移的旧形状）原样透传，供 isLegacyShape 识别。
 */
export function readLiveConfig(source: unknown): Record<string, unknown> {
  if (typeof source !== 'object' || source === null) return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    out[key] = isConfigRef(value) ? value.get() : value
  }
  return out
}

/**
 * 解析规则（统一一条逻辑）：
 *   1. platform === 当前平台 && mode 在注册表 → 正常；
 *   2. 否则 → 运行时用平台默认方式，stale = true，不覆盖文件；
 *   mode === 'off'（或未配置）→ 服务端不值守。
 */
export function parseSettings(value: unknown, platform: PlatformId | 'unsupported'): ParsedAwakeSettings {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  const configuredPlatform = typeof raw.platform === 'string' ? raw.platform : null
  const configuredMode = typeof raw.mode === 'string' ? raw.mode : null
  const config =
    typeof raw.config === 'object' && raw.config !== null ? (raw.config as Record<string, unknown>) : {}
  const registry = registryFor(platform)
  if (registry === undefined) {
    return { modeId: null, stale: false, configuredPlatform, configuredMode, config }
  }
  if (configuredMode === null || configuredMode === 'off') {
    return { modeId: null, stale: false, configuredPlatform, configuredMode, config }
  }
  if (configuredPlatform === platform && registry.modes[configuredMode] !== undefined) {
    return { modeId: configuredMode, stale: false, configuredPlatform, configuredMode, config }
  }
  return { modeId: registry.defaultMode, stale: true, configuredPlatform, configuredMode, config }
}

/** 从配置构建补全默认后的形状（丢弃 0.1.x 旧键；平台/方式缺省取当前平台默认）。 */
export function buildBase(
  entry: Record<string, unknown> | undefined,
  platform: PlatformId | 'unsupported',
): AwakeSettingsShape {
  const registry = registryFor(platform)
  return {
    version: CONFIG_VERSION,
    platform: typeof entry?.platform === 'string' ? entry.platform : platform,
    mode: typeof entry?.mode === 'string' ? entry.mode : (registry?.defaultMode ?? 'off'),
    config: typeof entry?.config === 'object' && entry?.config !== null ? (entry.config as Record<string, unknown>) : {},
  }
}

/** 0.1.x 旧形状 → 新形状（enabled/shellWakeLock/powerCfgWakeLock/why）。 */
export function migrateLegacyShape(
  raw: Record<string, unknown>,
  platform: PlatformId | 'unsupported',
): AwakeSettingsShape {
  const registry = registryFor(platform)
  let mode: string
  if (raw.enabled === false) {
    mode = 'off'
  } else if (raw.powerCfgWakeLock === true && raw.shellWakeLock !== true && platform !== 'unsupported') {
    // 只开 powerCfg → 该平台电源类实现。
    mode = powerModes[platform]
  } else {
    mode = registry?.defaultMode ?? 'off'
  }
  const config: Record<string, unknown> = {}
  if (typeof raw.why === 'string' && raw.why.length > 0) config.why = raw.why
  return { version: CONFIG_VERSION, platform, mode, config }
}

export class AwakeSettings {
  private parsed: ParsedAwakeSettings
  private writerImpl: ((next: AwakeSettingsShape) => Promise<unknown>) | null = null

  constructor(
    private readonly ctx: HostContext,
    /** 读取实时配置（生产：apply 收到的 config 引用树；引用被就地更新）。 */
    private readonly readSource: () => unknown,
    private readonly onReconcile: () => Promise<void>,
    private readonly logger: LoggerLike,
  ) {
    this.parsed = this.parse()
  }

  /** 当前解析结果（服务状态用）。 */
  get snapshot(): ParsedAwakeSettings {
    return this.parsed
  }

  /**
   * 写入钩子：整段替换插件配置（configEditor.edit 落盘 profile 配置）。
   * 服务/entry 缺席为 null = 只读。
   */
  get writer(): ((next: AwakeSettingsShape) => Promise<unknown>) | null {
    return this.writerImpl
  }

  /** 重新读取实时配置并解析（写入后 / 外部 volatile 更新后）。 */
  reload(): ParsedAwakeSettings {
    this.parsed = this.parse()
    return this.parsed
  }

  private parse(): ParsedAwakeSettings {
    const platform = detectPlatform()
    return parseSettings(buildBase(readLiveConfig(this.readSource()), platform), platform)
  }

  /** 装配：页面策略（抑制自动页）+ 写入钩子 + 外部配置变更监听。 */
  attach(): void {
    // 页面策略：配置面板已迁到「插件列表 → 插件详情」（plugins.bundle.config），
    // 不再向设置面板注册 settings.section。此时必须 auto:false —— settings 服务
    // 的 describe() 对每个插件条目默认 autoGenerate=true（presentations.get(fiber)
    // ?.auto ?? true），会自动按插件 Config schema 生成一个设置页；不关掉它，本
    // 插件会重新出现在 DSH 设置面板，与「退役 settings.section」的决定相悖。
    // （这与 dsh-yolo-mode 0.6.2 保留 configure({auto:false}) 的做法一致。）
    // configure 是 0.1.7 起 SettingsForms 的 API；老版 settings 服务没有它，
    // 这里做能力探测，避免在旧宿主上抛错。
    this.ctx.inject(['settings'], (sctx) => {
      const settings = sctx.settings
      if (settings === undefined || typeof settings.configure !== 'function') return
      sctx.effect(() => settings.configure({ auto: false }, this.ctx.fiber))
    })

    // 写入：configEditor.edit（0.1.7 官方写法，持久化到 profile 配置）。
    this.ctx.inject(['configEditor'], (cctx) => {
      const entry = this.ctx.fiber?.entry
      const editor: ConfigEditorService | undefined = cctx.configEditor
      if (editor === undefined) {
        this.logger.warn(`[${PLUGIN_ID}] configEditor 服务不可用，设置页写入停用（服务端照常值守）`)
        return
      }
      if (entry === undefined) {
        this.logger.warn(`[${PLUGIN_ID}] 未取得 Loader entry，设置写入不可用（只读；仅非 Loader 挂载时出现）`)
        return
      }
      this.writerImpl = (next) => editor.edit(entry, () => ({ ...next }))
      this.logger.info(`[${PLUGIN_ID}] 设置写入走 configEditor（profile 配置${entry.options?.id === undefined ? '' : ` ${entry.options.id}`}）`)
      void this.apply()
    })

    // 外部配置变更（用户手改 profile 配置 → loader 就地提交 volatile，不重启）：重新对账。
    this.ctx.on('loader/volatile-update', () => {
      void this.apply()
    })
  }

  private async apply(): Promise<void> {
    this.reload()
    void this.onReconcile()
    await this.maybeMigrate()
  }

  /**
   * 0.1.x → 新形状自动迁移：识别原始 config 的旧键，一次写回新形状（写回后不再命中，
   * 无循环）。写回会触发正常 Loader 热更新（旧键移除属非 volatile 变更 → 插件重启一次）。
   */
  private async maybeMigrate(): Promise<void> {
    const raw = readLiveConfig(this.readSource())
    if (!isLegacyShape(raw)) return
    const writer = this.writerImpl
    if (writer === null) return

    const next = migrateLegacyShape(raw, detectPlatform())
    try {
      await writer(next)
      this.logger.info(`[${PLUGIN_ID}] 检测到 0.1.x 旧配置，已自动迁移为 v${CONFIG_VERSION} 格式并保存到 profile 配置`)
    } catch (error) {
      // 迁移失败不阻塞：内存中已按新格式生效，下次设置页写入会落盘新格式。
      this.logger.warn(`[${PLUGIN_ID}] 0.1.x 旧配置自动迁移失败（${errorMessage(error)}），内存中已按新格式生效`)
    }
    this.reload()
  }
}
