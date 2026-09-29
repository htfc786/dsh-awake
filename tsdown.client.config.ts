/**
 * Client（浏览器）半构建：把 tsc 产物 lib/types/client/index.js 打包成
 * `window.__ModuleLoader__.load({ id, factory })` 形态的 CJS bundle。
 *
 * 要点（对齐 dsh-win-mgr 的做法）：
 *   - banner / intro / footer 拼出 ModuleLoader 工厂壳：`require` 由页面注入，
 *     react 系列走 loader 模块表（external），其余依赖全部内联；
 *   - sourcemap 输出到 lib/client.js.map，DSH 的 /plugins/<id>/client.js.map
 *     会原样服务，便于浏览器端调试。
 *
 * **包名从 package.json 的 `name` 读取，不硬编码**（id 与源码里的
 * `__DSH_AWAKE_PKG_NAME__` 同源）：DSH 要求 bundle 的 ModuleLoader id 等于
 * 包名（见 src/client/self.ts 的说明），scoped 安装（`@scope/dsh-awake`）下
 * 硬编码 `dsh-awake` 会导致整半加载失败。改包名发布时 `prepublishOnly` 会重新
 * 构建，id 自动对齐。
 */
import { readFileSync } from 'node:fs'
import { defineConfig } from 'tsdown'

/** 本包 package.json 的 name（= DSH 要求的 ModuleLoader id / slot key）。 */
const id: string = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).name
/** 由页面模块表提供的 external（bundle 内保持 require(...) 调用）。 */
const externals = ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime']

export default defineConfig({
  entry: { client: 'lib/types/client/index.js' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  clean: false,
  dts: false,
  sourcemap: true,
  deps: {
    neverBundle: externals,
    alwaysBundle: [/.*/],
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    __DSH_AWAKE_PKG_NAME__: JSON.stringify(id),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
