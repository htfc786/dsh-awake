# dsh-awake v0.2.0 重构设计稿

> 本文档是 dsh-awake 推倒重来的唯一设计依据。目标版本 0.2.0（破坏性重构）。
> 参考：`dsh-win-mgr`（工程化结构）、`dsh-pocket`（设置页 + 一键更新卡片）。
> 状态：设计评审中，未开始写代码。
>
> **0.2.1 兼容性修正**：DSH 0.1.5-rc 的 Connection 专用通道（`rpc.handle`）在第三方
> 插件里必挂（`webServer` 解析到提供方祖先链）；数据面改为 `POST /api/dsh-awake`
> 精确路由（`connection.fetch.register`），并且不再声明任何必需服务（见 3.3）。
>
> **0.2.2 适配 DSH 0.1.7（设置子系统）**：0.1.7 移除了 `settings.register` / `settings.get`
> （旧 `SettingsProvider`/`SettingsForms` 早期 API），设置改为「插件 Config schema +
> `configEditor`」单层模型。本版：`src/index.ts` 导出 `Config`（live 字段 `.volatile()`）；
> `src/host/settings.ts` 改为 `config.<field>.get()` 读实时值、`configEditor.edit(entry, …)`
> 写回当前 profile 插件配置、`settings.configure({auto:false})` 声明自定义页；旧的
> 「入口 config 作 base + settings.yaml 覆盖层」两层语义塌缩为 profile 插件 config 单层
> （0.1.7 的 `importLegacyDocument` 会把旧 settings.yaml 段一次性导入）。详见 3.2。
> 同时 `package.json` 的 `dsh.client.inject` 去掉 0.1.7 已删除的 `@deepseek-ai/dsh-client-runtime`
> （换为其后继 `@deepseek-ai/dsh-cordis-client-runner`，见 5）。

## 0. 设计原则

1. **平台优先、实现级粒度**：方式 = 具体实现文件（`systemd.ts`、`gnome-gsettings.ts`…），
   平台目录聚合。加实现 = 加一个文件 + 注册一行；加平台 = 加一个目录。
2. **配置最小化**：配置文件只记 `platform + mode + config`；浏览器 Wake Lock 是
   "每浏览器"状态，走 localStorage，不进配置。
3. **动态 schema**：配置字段由方式自己声明（`fields` 描述符），持久化 schema 宽松、
   校验在 host 侧，加实现不动 schema。
4. **分层**：client（浏览器 Wake Lock）与服务端（方式系统）完全解耦，互不依赖。
5. **单通道数据面**：所有设置页数据走 `POST /api/dsh-awake`（connection.fetch 精确
   路由），绕开官方 settings wire 白名单问题（win-mgr 实测踩坑）；不碰 webServer，
   也不用 `connection.rpc.handle`（0.2.1 起，原因见 3.3 与 README）。

## 1. 目录结构

```
src/
├── index.ts            # host 入口（{ name, inject, apply } → new AwakeService）
├── types.ts            # 跨半线格式（ModeInfo / AwakeStatus / ConfigField / Patch…）
├── shared/constants.ts # PLUGIN_ID / SETTINGS_NS / RPC_ROUTE_PATH / SLOT_ID / LOCALSTORAGE_KEY…
├── host/               # host 半（node）
│   ├── context.ts      # HostContext 最小结构类型（cordis 子集，零 @deepseek-ai 类型依赖）
│   ├── service.ts      # AwakeService 编排器（构造即装配，仿 WinMgrService）
│   ├── coordinator.ts  # 生命周期引用计数 + 回退链（拿锁/放锁）
│   ├── rpc.ts          # 数据面路由 POST /api/dsh-awake（status / select / refresh / version / update / restart）
│   ├── settings.ts     # settings 命名空间（宽松 schema + 动态校验 + stale 检测 + 老版配置转换）
│   └── version.ts      # 版本信息（current = 磁盘包版本 / loaded = 运行中版本）
├── modes/              # ★ 方式子系统（host 半核心业务）
│   ├── index.ts        # detectPlatform() + 平台注册表聚合（静态 import 三平台）
│   ├── shared/         # 看门狗脚本 / terminate / runCommand / 命令探测（跨实现复用）
│   ├── linux/
│   │   ├── index.ts    # order: ['systemd','gnome-gsettings']，default: 'systemd'
│   │   ├── systemd.ts  # systemd-inhibit 实现
│   │   └── gnome-gsettings.ts
│   ├── darwin/
│   │   ├── index.ts    # order: ['caffeinate','pmset']，default: 'caffeinate'
│   │   ├── caffeinate.ts
│   │   └── pmset.ts
│   └── win32/
│       ├── index.ts    # order: ['powershell','powercfg']，default: 'powershell'
│       ├── powershell.ts
│       └── powercfg.ts
└── client/             # client 半（浏览器；JSX）
    ├── index.ts        # plugins.bundle.config 注册 + locale + 样式清理 effect
    ├── types.ts        # ClientContext 最小结构类型（slots / sessions / locale / effect）
    ├── api.ts          # 数据面封装（同源 fetch，status / select / refresh…）+ compareVersions
    ├── locales.ts      # zh/en 文案字典（zh 为基准，en 可后补）
    ├── state.ts        # 状态判别（LoadState / FallbackState 等）
    └── components/
        ├── AwakeSection.tsx     # 设置页主组件（2.1–2.4 组装）
        ├── StatusRow.tsx        # 2.1 状态行
        ├── NoticeArea.tsx       # stale / 回退 / 失败提示（黄/红）
        ├── UpdateCard.tsx       # 2.2 版本更新卡片（仅新版时渲染）
        ├── BrowserWakeToggle.tsx# 2.3 浏览器防休眠开关（localStorage）
        └── ModeSelect.tsx       # 2.4 方式下拉 + 说明区 + 动态配置表单
```

构建管线（对齐 win-mgr）：`tsconfig.{base,host,client}.json` + `tsdown.{host,client}.config.ts`
+ vitest。host 打 ESM 单文件；client 打 `window.__ModuleLoader__.load` CJS 工厂壳。

## 2. 方式子系统（src/modes）

### 2.1 方式接口

```ts
// src/modes/index.ts
export type PlatformId = 'linux' | 'darwin' | 'win32'

export interface PlatformRegistry {
  platform: PlatformId
  order: string[]                       // 方式 id 列表：= 下拉顺序 = 回退顺序
  defaultMode: string                   // 平台默认方式 id
  modes: Record<string, WakeMode>
}

export function detectPlatform(): PlatformId | 'unsupported'
export const registries: Record<PlatformId, PlatformRegistry>  // 静态 import 聚合
```

```ts
// 单个实现
export interface WakeMode {
  id: string                            // = 文件名，如 'systemd'
  name: string                          // 下拉项短名，如 'systemd-inhibit'
  description: string                   // 一段介绍：原理、适用条件、注意事项（UI 说明区）
  default: boolean                      // 是否平台默认
  fields: ConfigField[]                 // 配置字段，可为空数组
  isAvailable(): { ok: true } | { ok: false; reason: string }   // 探测，可缓存
  start(config: Record<string, unknown>): Promise<ModeSession>
}

export interface ModeSession {
  readonly description: string          // 日志/状态用，如 'linux · systemd-inhibit sleep infinity'
  isActive(): boolean                   // 运行状态（进程活着/设置已改）
  stop(): Promise<void>                 // 幂等
}
```

### 2.2 配置字段描述符（动态 schema，纯数据不写 TSX）

```ts
export type ConfigField =
  | { type: 'text'; content: string }                                                       // 纯说明文字，无 key，不产生配置值
  | { type: 'input';    key: string; title: string; hint?: string; placeholder?: string; default?: string }         // 单行文本
  | { type: 'textarea'; key: string; title: string; hint?: string; default?: string; rows?: number }                // 多行文本
  | { type: 'boolean';  key: string; title: string; hint?: string; default?: boolean }                              // 开关
  | { type: 'select';   key: string; title: string; hint?: string; default?: string; options: Array<{ label: string; value: string }> }
  | { type: 'number';   key: string; title: string; hint?: string; default?: number; min?: number; max?: number }   // 数字
```

- 加类型 = client 半加一个渲染分支 + 这里加一行，host 半不用动（持久化宽松）。
- 例：`linux/systemd.ts` → `fields: [ { type: 'text', content: '通过 systemd-inhibit 阻止系统休眠，需要 systemd 环境…' },
  { type: 'input', key: 'why', title: '阻止原因', hint: '显示在 systemd-inhibit --list 中', default: 'dsh 任务执行中' } ]`
- `darwin/caffeinate.ts`、`win32/powershell.ts` 等 → `fields: []`（或只有 `text` 说明）。

### 2.3 平台注册表示例

```ts
// src/modes/linux/index.ts
import { systemd } from './systemd.ts'
import { gnomeGsettings } from './gnome-gsettings.ts'
export const linuxRegistry = {
  platform: 'linux',
  order: ['systemd', 'gnome-gsettings'],   // 回退顺序 = 下拉顺序
  defaultMode: 'systemd',
  modes: { systemd, 'gnome-gsettings': gnomeGsettings },
}
// src/modes/index.ts 静态 import 三平台注册表聚合为 registries
```

## 3. host 半

### 3.1 协调器（coordinator.ts）——保留现有引用计数，加回退链

- `ctx.on('session/event')`：`turn/start` 0→1 拿锁，`turn/end` 1→0 放锁（跨会话引用计数保留）。
- **常开防休眠（`alwaysOn`）**：**纯内存状态**（host 服务字段，不写配置文件，
  宿主重启即失效，设置页每次用时再开）。`alwaysOn: true` 时，协调器在
  `openTurns = 0` 也保持/获取锁（RPC `awake.alwaysOn` → 对账），
  `turn/end` 1→0 不触发放锁；关闭常开且无任务 → 放锁。
  拿锁前置条件 = `openTurns > 0 || alwaysOn`。
- 拿锁（回退语义，已确认）：
  ```
  首选 = 配置的 mode（若与当前平台匹配且在注册表中）
  尝试序列 = [首选, ...platform.order 去掉首选]
  对每个方式：
    1. 新鲜 isAvailable() 失败 → 记原因，下一个
    2. start() 失败/抛错 → 记原因，下一个
  成功 → effective = 该方式；全部失败 → effective = null（关闭），attempts 记录每个失败原因
  ```
- 放锁：stop 所有已启动的 session（幂等）。
- 设置变更（settings/updated）→ 若 `openTurns > 0` 则先放锁再按新配置拿锁（对账）。
- 插件卸载 → 无条件放锁（effect disposer，保留现状）。

### 3.2 配置（DSH 0.1.7：插件 Config schema + configEditor）

> **0.2.2 重写**：0.1.7 移除了 `settings.register(ns, schema, {base})` / `settings.get(ns)`
> （旧 `SettingsProvider`）。设置改为「插件 Config」单层——插件的 Config schema 就是权威
> 设置面，值来自**当前 profile 的插件条目 config**；不再有 settings.yaml 覆盖层。

```yaml
# 当前 profile 配置层里 dsh-awake 条目的 config（设置页写回此处）
version: 2          # 当前配置文件版本：2，如果有老配置，自动转换新的配置
platform: linux     # 锚点：上次写入配置的平台（复制 .dsh 到其他系统时识别）
mode: systemd       # 当前平台选中的方式（= 实现文件名）；'off' = 关闭服务端
config:             # 该方式的配置；多数方式为空 {}，字段由方式声明
  why: 'dsh 任务执行中'
# 注：常开防休眠（alwaysOn）不在此处——纯内存状态，见 3.1。
```

- 声明：`src/index.ts` 导出 `Config`（schemastery；live 字段 `.volatile()`）——**绝不在
  schema 里枚举 config 键**（`config` 用 `any()`，键由方式声明、校验在 host 侧）。
- 读：`apply(ctx, config)` 收到解析后的引用树，`config.<field>.get()` 读实时值；
  loader 的 `_commitVolatile` 在写入时就地更新引用（**不重启插件**）。
- 写：`configEditor.edit(entry, () => next)` 整段写回当前 profile 插件配置。
- 页面策略：`settings.configure({ auto: false }, fiber)`（awake 自带设置页）。
- 外部变更：监听 `loader/volatile-update` → 重新解析 + 协调器对账。
- 解析规则（跨平台复制 / 插件升级实现被删，统一一条逻辑，`parseSettings` 不变）：
  1. `platform === 当前平台 && mode 在注册表` → 正常；
  2. 否则 → 运行时用平台默认方式，`stale = true`，**不覆盖配置**（拷回原系统配置仍可用），
     设置页黄色提示"检测到配置来自 Windows，当前为 Linux，已使用默认方式 systemd"；
  3. 用户下一次保存时 `platform` 更新为当前平台。
- `mode === 'off'`：服务端不值守，状态行显示"未启用"，无红色提示（用户主动选择）。
- 迁移：0.1.7 的 `SettingsForms.importLegacyDocument` 会把旧 `settings.yaml` 段一次性导入；
  更早的 0.1.x 旧形状（`enabled`/`shellWakeLock`/…）由 `maybeMigrate` 识别原始 config 后
  经 `configEditor.edit` 写回新形状（写回后不再命中，无循环）。
- **两层 → 单层的取舍**：旧模型「入口 config 作 base + settings.yaml 覆盖层」塌缩为
  「profile 插件条目 config 单层」。用户可感知行为不变（设置页热改、跨平台 stale 提示、
  off 语义、迁移都保留）；差异是写入落点从 settings.yaml 变为 profile 插件配置，且
  config 写入经 loader 的 volatile 通道（不重启插件、内存态 alwaysOn 保留）。

### 3.3 数据面路由（rpc.ts）

- 路由：`POST /api/dsh-awake`（host `connection.fetch.register`，client 同源 `fetch`）。
  请求体 `{ method, payload }`，响应体 `RpcResult`（`src/types.ts` 的 `RpcRequest`）。
- 为什么不是 `connection.rpc.handle('/dsh-awake')`：DSH 0.1.5-rc 起那条专用通道
  注册时会读**服务提供方 fiber 祖先链**上的 `webServer`（`owner.effect(() =>
  owner.webServer.register(route))`，owner 是提供方 ctx 的影子），而第三方插件条目
  与 webserver 条目是兄弟条目 → 必抛 `cannot get property "webServer" without
  inject`，整棵加载树失败。`connection.fetch` 只碰消费方自己的 fiber，且天然
  复用 /api 的 Host/Origin + 登录栅栏（401/403）。
- 端点：
  | 端点 | 入参 | 返回 | 说明 |
  |---|---|---|---|
  | `awake.status` | `{}` | `AwakeStatus` | 状态 + 方式列表 + 可用性 + 版本 |
  | `awake.refresh` | `{}` | `AwakeStatus` | 失效可用性缓存重新探测（刷新按钮） |
  | `awake.select` | `{ mode, config? }` | `AwakeStatus` | 写配置：normalize → settings.update → 对账 |
  | `awake.alwaysOn` | `{ enabled }` | `AwakeStatus` | 常开防休眠开关：**内存置位**（不写配置文件）→ 协调器对账（openTurns=0 也拿/放锁）；模式为 off 时开启报错 |
  | `awake.version` | `{}` | `{ current, loaded }` | 更新卡片用（也可并入 status） |
  | `awake.update` | `{}` | `{ ok, output, autoRestart }` | 一键更新（dsh plugin update，移植 dsh-pocket） |
  | `awake.restart` | `{}` | `{ ok }` | 重启宿主生效（更新后） |
- 错误形状对齐 dsh-pocket rpcErrorSchema：`{ ok: false, error: { code, message, details } }`；
  支持 signal.aborted → `cancelled`。请求体非 JSON / 缺 `method` → HTTP 400 + 信封。
- 注册时机：connection 是 **web 专属可选服务**，host/service.ts 用
  `ctx.inject(['connection'], …)` 等它出现再注册；插件 export `inject` 为空，
  因此 headless / tui 档位照常值守，只是没有设置页数据面。

### 3.4 跨半线格式（types.ts）

```ts
export interface AwakeStatus {
  platform: PlatformId
  selected: string | null      // 配置的 mode；null = 关闭
  effective: string | null     // 实际生效（回退后）；null = 服务端未值守
  active: boolean              // 是否值守中（openTurns > 0 且已启动）
  openTurns: number
  stale: boolean               // 配置来自其他平台 / mode 失效
  attempts: AttemptLog[]       // 最近一次拿锁的尝试记录
  modes: ModeInfo[]            // 当前平台全部方式（下拉渲染）
  version: { current: string; loaded: string }
  desktop: boolean             // DSH Desktop 环境（更新由桌面版管理）
}
export interface ModeInfo {
  id: string; name: string; description: string
  default: boolean
  available: boolean; reason: string | null   // 不可用原因（disabled 提示）
  fields: ConfigField[]
}
export interface AttemptLog { id: string; ok: boolean; reason?: string }
```

## 4. client 半（插件详情页配置面板）

### 4.1 注册（plugins.bundle.config，对齐 dsh-yolo-mode 0.6.x）

```ts
export const inject = ['slots', 'sessions', 'locale']
// ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
//   name: 'plugins.bundle.config', key: 'dsh-awake', locale: 'settings.awake',
//   inject: () => ({ api, manager, t }),
// }, AwakeSection))
```

- 配置渲染在「插件列表 → dsh-awake」详情页（包描述与组件行之间）。该 keyed slot 以
  npm 包名为 key，只在注册了与包名相同的 key 时页面才渲染配置区块。bundle 页只请求
  `view:'page'`，且不传宿主 `form`（草稿/校验/保存由本插件自持，走 `/api/dsh-awake`）。
- `settings.section` 已退役，DSH 设置面板不再出现本插件；宿主侧 `settings.configure({ auto: false })`
  保留，抑制宿主按 Config schema 自动生成的设置页。
- `sessions`：2.3 浏览器 Wake Lock 需要"是否有任务在运行"（保留现有 WakeLockManager 逻辑）。
- `locale`：zh 基准 + en 可后补（结构预留，先只填 zh 也行）。

### 4.2 页面布局（2.1–2.4 全部确认项）

```
┌─ dsh-awake（插件详情页配置面板）─────────────────────────┐
│ [● 后端已连接] [● 值守中 · systemd]            [🔄 刷新] │  ← 2.1 状态行
│ ──────────────────────────────────────────────────────   │
│ ⚠ 配置来自 Windows，当前为 Linux，已使用默认方式 systemd  │  ← 提示区（黄）
│ ❌ 防休眠未能生效：systemd-inhibit 未找到；gnome-gsettings │  ← 提示区（红）
│    执行失败（退出码 1）                                   │
│ ──────────────────────────────────────────────────────   │
│ 📦 新版本 v0.2.1（当前 v0.2.0）               [一键更新]  │  ← 2.2 更新卡片（仅新版）
│ ──────────────────────────────────────────────────────   │
│ 为当前浏览器开启页面防休眠                     [开/关]    │  ← 2.3 浏览器开关
│ （不写入配置文件，仅本浏览器生效）                         │
│ ──────────────────────────────────────────────────────   │
│ 插件运行模式                                               │
│ [systemd-inhibit ▾]   （不可用项 disabled + 原因）        │  ← 2.4 方式下拉
│ 说明：通过 systemd-inhibit 阻止系统休眠，需要 systemd 环境 │  ← 选中方式的 description
│ 阻止原因 [dsh 任务执行中                ]                 │  ← 动态表单（fields）
│ ──────────────────────────────────────────────────────   │
│ 🛡 常开防休眠（无论是否有任务都持续值守）      [开/关]    │  ← 2.5 常开开关（页面底部）
└──────────────────────────────────────────────────────────┘
```

- 状态行轮询：打开设置页时拉取 + 每 5s 轮询（dsh-pocket 同款）；刷新按钮 = `awake.refresh`
  （失效可用性缓存重新探测）。
- 提示区规则：`stale` → 黄；`attempts` 有失败但 `effective` 非 null → 黄（"首选失败，当前
  生效 XX：原因"）；`effective === null && attempts 全失败` → 红（列每个原因）；
  用户选 `off` → 不提示。
- 2.3：`localStorage['dsh-awake.webWakeLock']` 默认 `true`，仅控制浏览器 Wake Lock，
  与 2.4 完全独立。

### 4.3 更新卡片（移植 dsh-pocket，已确认一键更新）

- 参考`dsh-pocket`样式，位置`/home/htfc786/.dsh/profiles/web/node_modules/dsh-pocket/`
- host 暴露 `{ current, loaded }`（current = 磁盘包版本，loaded = 运行中版本）。
- client `fetch('https://registry.npmjs.org/dsh-awake/latest', { cache: 'no-store' })`
  + `compareVersions`（移植 api.js，MIT）+ 周期重查 5 分钟 + 网络失败静默。
- 状态机：无新版（不渲染）/ 有新版（提示 + 一键更新）/ 更新中 / 已更新未重启
  （"重启生效"按钮）/ 失败（显示输出）。
- `desktop === true`：不渲染（更新由 DSH Desktop 管理）。

## 5. 构建与工程化（对齐 win-mgr）

- `tsconfig.base.json` + `tsconfig.host.json`（node）+ `tsconfig.client.json`（browser，含 JSX）。
- `tsdown.host.config.ts`：host 半 → `lib/index.js`（ESM 单文件）。
- `tsdown.client.config.ts`：client 半 → `lib/client.js`（CJS + `__ModuleLoader__` 工厂壳，
  banner/intro/footer 拼装；react/运行时模块 external）。
- `pnpm run build` = clean + tsc(host) + tsdown(host) + tsc(client) + tsdown(client)。
- vitest（替换现有 tests/*.mjs 手写脚本）：单测 modes（注入 fake 的
  isAvailable/start/stop）、协调器引用计数与回退链、compareVersions、stale 检测、
  描述符→表单渲染；集成：看门狗进程测试（保留）、数据面路由往返。

## 6. 迁移（0.1.1 → 0.2.0）

- 旧配置 `{ enabled, shellWakeLock, powerCfgWakeLock, webWakeLock, why }`：
  - `webWakeLock` → 浏览器 localStorage（默认开），settings.yaml 旧字段删除；
  - `shellWakeLock / powerCfgWakeLock` → `mode`：只开 powerCfg → 该平台电源类实现
    （gnome-gsettings / pmset / powercfg），否则 → 平台默认实现；
  - `why` → `config.why`；
  - 迁移在 host 首次加载时识别旧形状执行一次，写回新格式。
- README 重写（新配置格式 / 设置页说明 / 方式清单）。
- 版本 bump 0.1.1 → 0.2.0（npm 已发布 0.1.1，更新卡片前提成立）。

## 7. 实施顺序

1. **骨架**：types.ts + shared/constants.ts + 双 tsconfig/tsdown/vitest 空壳 + package.json 调整。
2. **modes 子系统**：shared 工具（看门狗/terminate/runCommand/probe）+ 6 个实现 +
   3 个平台注册表（原 shell.ts/power.ts 逻辑平移，抽公共部分）。
3. **host**：coordinator（引用计数 + 回退）+ settings（宽松 schema + stale）+ rpc + service 入口。
4. **client**：api.ts + 5 个组件 + plugins.bundle.config 注册 + WakeLockManager 接 localStorage。
5. **收尾**：迁移逻辑 + README + 版本 bump + 打包验证（`pnpm build` + 装进测试 profile 验收）。

## 8. 待确认的小点（未阻塞，默认值如下）

- 回退序列先 `isAvailable()` 预检再 `start()`（预检省得真启动；运行时变化由 start 失败兜底）。✔ 采用
- 平台锚点与"mode 找不到"双保险（锚点用于提示文案，找不到作为兜底，解析同一条逻辑）。✔ 采用
