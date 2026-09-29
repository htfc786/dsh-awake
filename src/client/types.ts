/**
 * Client 侧最小上下文类型（DSH client runtime 的结构子集）。
 * 刻意不依赖 @deepseek-ai/* 的类型：运行时由 client runner 注入真实 ctx，
 * 这里只声明本插件用到的面（slots / sessions / locale / effect）。
 */

/** plugins.bundle.config 注册选项（对齐官方 ui-plugin-manager 的 keyed slot 契约）。 */
export interface PluginBundleConfigOptions {
  readonly name: 'plugins.bundle.config'
  /** key = npm 包名；页面只在注册了与包名相同的 key 时渲染配置区块。 */
  readonly key: string
  /** 组件文案的 locale 命名空间。 */
  readonly locale: string
  /** 注入给组件的字段（组件 props = 宿主 owner props { view } + 本注入面）。 */
  readonly inject: () => Record<string, unknown>
}

/** slots 服务（dsh-client-ui-slots 的结构子集）。 */
export interface SlotsService {
  inject(slot: string, contribution: () => unknown): unknown
  register(options: PluginBundleConfigOptions, component: unknown): unknown
}

/** locale 服务（dsh-client-locale 的结构子集）。 */
export interface LocaleService {
  register(namespace: string, dicts: Record<string, Record<string, string>>): () => void
  bind(namespace: string): (key: string) => string
}

/** 会话列表行（结构子集：wake lock 只看 running）。 */
export interface SessionSummary {
  readonly running: boolean
}

/** sessions.list 快照（结构子集）。 */
export interface SessionListSnapshot {
  readonly byId: Record<string, SessionSummary>
}

/** sessions.list 可观察对象（结构子集）。 */
export interface SessionListObservable {
  getSnapshot(): SessionListSnapshot
  subscribe(listener: () => void): () => void
}

/** sessions 服务（dsh-client-runtime 的结构子集）。 */
export interface SessionsService {
  readonly list: SessionListObservable
}

/** Client 侧 cordis 上下文。 */
export interface ClientContext {
  readonly slots: SlotsService
  readonly sessions: SessionsService
  readonly locale: LocaleService
  /** 注册一次性副作用；callback 立即执行，其返回值才是卸载时的清理函数。 */
  effect(dispose: () => void, label?: string): unknown
}
