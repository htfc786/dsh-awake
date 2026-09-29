/**
 * Host 侧最小上下文类型（cordis Context 的结构子集）。
 *
 * 刻意不依赖 @deepseek-ai/cordis 的类型：运行时由 Cordis 注入真实 ctx，
 * 这里只声明本插件用到的面（on / effect / inject / get / fiber / connection），
 * 避免为本包引入 peer 依赖链。
 *
 * DSH 0.1.7 起设置子系统改为「插件 Config schema + configEditor」：
 *   - 插件导出 Config（schemastery，live 字段 .volatile()），apply(ctx, config)
 *     收到解析后的 config 引用树，用 config.<field>.get() 读实时值；
 *   - 写入走 configEditor.edit(entry, updater)（持久化到 profile 配置）；
 *   - settings.configure({ auto }, fiber) 声明页面策略（自定义页 → auto:false）。
 */

/** logger 服务的结构子集（cordis LoggerService：可调用 + 直接方法）。 */
export interface LoggerLike {
  (name?: string): LoggerLike
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

/** 一个 schemastery volatile 字段的引用（.get() 读实时值）。 */
export interface ConfigRef<T = unknown> {
  get(): T
}

/** apply(ctx, config) 收到的解析后 Config（live 字段为 volatile 引用）。 */
export interface ResolvedConfig {
  readonly version?: ConfigRef
  readonly platform?: ConfigRef
  readonly mode?: ConfigRef
  readonly config?: ConfigRef
  /** 旧形状（未迁移）未知键透传在对象上；宽松读取。 */
  readonly [key: string]: unknown
}

/** settings 服务的结构子集（dsh-settings 的 SettingsForms；0.1.7 起仅页面策略）。 */
export interface SettingsService {
  configure(presentation: { auto?: boolean }, owner?: unknown): () => void
}

/** configEditor 服务的结构子集（dsh-config-editor：持久化到 profile 配置）。 */
export interface ConfigEditorService {
  /** 用 change 计算下一份完整 raw config 并落盘 + 正常 Loader 热更新。 */
  edit(
    entry: unknown,
    change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void>
}

/** Loader entry 的结构子集（取 id 与原始 config）。 */
export interface HostEntry {
  readonly options?: {
    readonly id?: string
    readonly config?: Record<string, unknown>
  }
}

/** 插件 fiber 的结构子集。 */
export interface HostFiber {
  readonly entry?: HostEntry
  readonly config?: unknown
}

/** 一条精确 Fetch 路由（dsh-client-connection 的 ConnectionFetchRoute 结构子集）。 */
export interface ConnectionFetchRoute {
  /** 必须是 /api 之下的绝对路径（如 /api/dsh-awake）。 */
  readonly path: string
  readonly methods: readonly ('GET' | 'HEAD' | 'POST')[]
  /** buffered = 桥接层先按 JSON 体积上限聚合请求体。 */
  readonly requestBody: 'buffered' | 'streaming'
  /** 物理载体（webserver 的 /api 前缀路由）已应用信任 + 登录栅栏后再调用。 */
  readonly fetch: (request: Request) => Promise<Response>
}

/**
 * connection 服务的结构子集（dsh-client-connection host 半）。
 *
 * 只用共享 /api 通道的精确路由注册表：官方 file-upload / deliverables /
 * session-log-export 等都用它。**刻意不用 rpc.handle**——它在注册时要读
 * 提供方 fiber 祖先链上的 webServer，第三方插件拿不到（见 shared/constants.ts）。
 */
export interface ConnectionService {
  readonly fetch: { register(route: ConnectionFetchRoute): () => Promise<void> | void }
}

/** ctx.inject([...], ...) 回调里的子上下文：请求的服务以可选属性出现。 */
export interface InjectedContext {
  readonly settings?: SettingsService
  readonly configEditor?: ConfigEditorService
  /** 仅当 inject 列表包含 connection 时存在。 */
  readonly connection?: ConnectionService
  readonly on: HostContext['on']
  readonly effect: HostContext['effect']
}

/** Host 侧 cordis 上下文。 */
export interface HostContext {
  readonly logger: LoggerLike
  /** 插件自身 fiber（取 entry id / loader 配置；settings.configure 的 owner）。 */
  readonly fiber?: HostFiber
  /** 注册一次性副作用；callback 立即执行，其返回值才是卸载时的清理函数。 */
  effect(dispose: () => void, label?: string): unknown
  /** 订阅事件。 */
  on(event: string, listener: (...args: unknown[]) => void): unknown
  /** 读取可选服务（如 connection / configEditor）；不存在返回 undefined。 */
  get<T = unknown>(service: string): T | undefined
  /** 注入可选服务（如 settings / configEditor / connection），回调收到带该服务的子上下文。 */
  inject(services: readonly string[], callback: (sctx: InjectedContext) => void): unknown
  /** 读取 connection 服务（可选；缺席时设置页数据面停用，服务端照常值守）。 */
  readonly connection?: ConnectionService
}

/**
 * 健壮地读取可选服务：先属性访问（需 inject 声明，沿 fiber 链解析；服务缺失或
 * 未声明 inject 时 cordis 抛错被捕获），再 ctx.get()（按 isolate 直读全局表）。
 * 用于 desktopProfiles / desktopPnpm 这类「有就读、没有就算」的探测。
 */
export function getOptionalService<T>(ctx: HostContext, name: string): T | undefined {
  try {
    const value = (ctx as unknown as Record<string, T | undefined>)[name]
    if (value !== undefined) return value
  } catch {
    // 属性访问在服务缺失/未声明 inject 时抛错；忽略，继续尝试 ctx.get。
  }
  try {
    return ctx.get<T>(name)
  } catch {
    return undefined
  }
}
