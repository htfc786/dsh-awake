import { readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'

/**
 * 源码单测里 `__DSH_AWAKE_PKG_NAME__` 与生产 bundle 同源（都取 package.json 的
 * name），这样测试锁定的「slot key === 本包实际包名」不变量才与构建产物一致。
 */
const pkgName: string = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).name

export default defineConfig({
  define: {
    __DSH_AWAKE_PKG_NAME__: JSON.stringify(pkgName),
  },
  test: {
    environment: 'node',
    // globals 开启后 @testing-library/react 的自动 cleanup 才能挂到 afterEach，
    // 避免 jsdom DOM 在用例之间累积。
    globals: true,
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    // 进程级测试（看门狗/集成）依赖 pgrep 计数，跨文件并行会互相干扰，串行执行。
    fileParallelism: false,
  },
})
