/**
 * dsh-awake —— DeepSeek Harness 防休眠插件（守夜人）v0.2.3。
 *
 * host（node）半入口：监听 agent 会话生命周期（`session/event` 的
 * `turn/start` / `turn/end`），在「有任务正在执行」期间持有防休眠锁，
 * 任务结束后释放。方式子系统（src/modes）按平台聚合实现，拿锁时按
 * 配置 + 回退链逐个尝试（见 DESIGN.md 3.1）。
 *
 * Cordis 插件契约：具名导出 { name, Config, inject, apply }。
 * DSH 0.1.7 起设置改为「插件 Config + configEditor」：Config 的 live 字段标
 * .volatile()，apply(ctx, config) 收到解析后的引用树，写入走 configEditor（见
 * src/host/settings.ts）。
 */
import z from '@deepseek-ai/schemastery'
import { AwakeService } from './host/service.js'
import { PLUGIN_ID } from './shared/constants.js'
import type { ResolvedConfig } from './host/context.js'

export type {
  AwakeSettingsShape, AwakeStatus, AwakeVersion, AttemptLog, ConfigField, ModeInfo,
  RestartResult, RpcError, RpcResult, SelectRequest, UpdateResult,
} from './types.js'

/** 插件包名（= Cordis 条目名）。 */
export const name = PLUGIN_ID

/**
 * 插件配置（DSH 0.1.7 的 settings 声明面；旧版 settings.register 已移除）。
 * live 字段一律 .volatile()：设置写入时由 loader 就地更新引用（不重启插件）。
 * config 用 any()——键由方式自声明，绝不在此枚举（宽松 schema，校验在 host 侧）。
 */
export const Config = z.object({
  version: z.number().description('配置文件版本（当前 2；老配置自动转换）').volatile(),
  platform: z.string().description('锚点：上次写入配置的平台（复制 .dsh 到其他系统时识别）').volatile(),
  mode: z.string().description('当前平台选中的方式（= 实现文件名）；off = 关闭服务端').volatile(),
  config: z.any().description('该方式的配置；字段由方式声明（宽松 schema）').volatile(),
})

/**
 * 依赖的宿主服务：**无必需项**。
 *
 * 防休眠本身只靠 session 事件 + 平台命令，任何档位（web / tui / headless）都能跑；
 * 设置页数据面依赖 web 专属的 connection 服务、配置写入依赖 configEditor，均由
 * host/service.ts / host/settings.ts 用 ctx.inject([…]) 等它们出现再装配
 * （写入 export inject 会让条目在没有该服务的档位一直 pending，整棵树加载失败）。
 */
export const inject: readonly string[] = []

/** 装配入口：构造 AwakeService 即完成协调器 + 配置 + RPC 装配。 */
export function apply(ctx: import('./host/context.js').HostContext, config: ResolvedConfig = {}): void {
  void new AwakeService(ctx, config)
}
