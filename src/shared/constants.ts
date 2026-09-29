/**
 * dsh-awake 的跨半常量（host 与 client 共享，各自打进自己的 bundle）。
 * 命名与约定见 DESIGN.md —— 勿改。
 */

/** 插件包名（也是 Cordis 条目名 / 配置条目 id / plugins.bundle.config 的 key）。 */
export const PLUGIN_ID = 'dsh-awake'

/** 配置面板 locale 命名空间（client 半注册到 dsh-client-locale）。 */
export const SETTINGS_LOCALE_NS = 'settings.awake'

/**
 * 设置页数据面路由（绕开官方 settings wire 白名单，见 DESIGN.md 3.3）：
 * POST /api/dsh-awake，请求体 `{ method, payload }` → 响应 `RpcResult`，由
 * host 半 `connection.fetch.register` 注册为 /api 共享通道上的精确路由，
 * 因此沿用 Connection 的 Host/Origin + 浏览器登录栅栏（401/403）。
 *
 * 不能用 `connection.rpc.handle`：那条专用通道在注册时会把 `webServer` 解析到
 * 服务提供方 fiber 的祖先链上，而第三方插件的条目与 webserver 条目是兄弟，
 * DSH 0.1.5-rc 起必抛 "cannot get property webServer without inject"（详见 README）。
 */
export const RPC_ROUTE_PATH = '/api/dsh-awake'

/** 浏览器 Wake Lock 的 localStorage 键（每浏览器状态，不进配置文件）。 */
export const LOCALSTORAGE_KEY = 'dsh-awake.webWakeLock'

/** 配置文件版本：2（有老配置时自动转换，见 host/settings.ts 迁移逻辑）。 */
export const CONFIG_VERSION = 2

/** npm registry 最新版探测地址（更新卡片用，带 CORS *）。 */
export const NPM_REGISTRY_URL = 'https://registry.npmjs.org/dsh-awake/latest'
