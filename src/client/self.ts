/**
 * 本插件自身的 npm 包名 —— 由构建期注入（见 tsdown.client.config.ts / vitest.config.ts，
 * 二者都从 package.json 的 `name` 读取），**不硬编码**。
 *
 * 为什么必须取「实际包名」而不是硬编码（三处 DSH 契约，均已从 0.1.7-rc.2 源码核实）：
 *   1) 客户端 bundle 的 ModuleLoader id 必须等于包名：`dsh-client-modules`
 *      以 `packageName`（package.json 的 name，含 scope）作为 boot graph 的行 id
 *      （lib/index.js:884 `graphRow(packageName, …)`），加载时校验
 *      `factories.has(id)`（lib/client.js:625/739），id 不符即整半加载失败；
 *   2) `plugins.bundle.config` 的 key 必须等于**安装名**：插件详情页以
 *      `configured = ledger.bundles.has(openPkg.name)` 决定是否渲染配置区块
 *      （dsh-client-ui-plugin-manager/lib/client.js:2879），而 `openPkg.name` 是
 *      profile 依赖 / `dsh.profile.bundles` 的条目名，并非 manifest name；
 *   3) `dsh-client-modules` 还要求 **Loader 行名 == package.json 的 name**：扫描
 *      `dsh.client` 时 `nearestPackage()` 以「最近 package.json 的 name」匹配行名，
 *      不等即**静默跳过**该包（不报错、不告警）——npm alias 安装
 *      （`"dsh-awake": "npm:@scope/dsh-awake@x"`）正落在这里。
 *
 * 包名在**构建期**已知（bundle 在脚本执行时就要注册正确的 ModuleLoader id，
 * 运行时再取已来不及），故用 define 注入单一常量。注意它**只覆盖 bundle id 与
 * slot key**，不覆盖静态的 `cordis.patch.yml`（Loader 行名）。因此下列四者必须逐字
 * 一致：`package.json.name` == `cordis.patch.yml` 里 insert 的 `name` == 安装名
 * == bundle id / slot key；换名发布时除 `prepublishOnly` 重新构建外，还需同步
 * `cordis.patch.yml` 的 name，并保证不做 alias 安装。
 */
declare const __DSH_AWAKE_PKG_NAME__: string

/** 本包实际 npm 包名（= package.json 的 name，例如 `dsh-awake` 或 `@scope/dsh-awake`）。 */
export const SELF_PACKAGE_NAME: string = __DSH_AWAKE_PKG_NAME__
