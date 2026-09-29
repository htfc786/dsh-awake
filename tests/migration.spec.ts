/**
 * 迁移逻辑测试：0.1.x 旧配置（enabled/shellWakeLock/powerCfgWakeLock/webWakeLock/why）
 * → 新格式（version/platform/mode/config）自动转换，写回一次且不循环。
 *
 * DSH 0.1.7 模型：读取走 apply 收到的 config 引用树，写入走 configEditor.edit。
 * 这里用 fake configEditor（把写回的 raw config 换进同一份配置对象，模拟 loader
 * 就地重建）驱动迁移。
 */
import { describe, expect, it } from 'vitest'
import { CONFIG_VERSION } from '../src/shared/constants.js'
import { AwakeSettings } from '../src/host/settings.js'
import type { ConfigEditorService, HostContext, LoggerLike } from '../src/host/context.js'

const silentLogger: LoggerLike = { info: () => {}, warn: () => {}, error: () => {} }

interface Harness {
  /** configEditor.edit 落盘的完整 raw config（每次写入一条）。 */
  readonly writes: Array<Record<string, unknown>>
  /** 当前（内存/落盘）配置原文。 */
  get config(): Record<string, unknown>
}

/** fake configEditor：edit 计算下一份 raw config，替换配置对象内容（模拟重载）。 */
function makeEditor(source: Record<string, unknown>, writes: Array<Record<string, unknown>>): ConfigEditorService {
  return {
    edit: async (_entry, change) => {
      const next = change({ ...source }, {})
      writes.push(next)
      for (const key of Object.keys(source)) delete source[key]
      Object.assign(source, next)
    },
  }
}

function makeHarness(initial: Record<string, unknown>): Harness {
  const source: Record<string, unknown> = { ...initial }
  const writes: Array<Record<string, unknown>> = []
  const editor = makeEditor(source, writes)

  const ctx: HostContext = {
    logger: silentLogger,
    fiber: { entry: { options: { id: 'dsh-awake', config: source } } },
    effect: () => {},
    on: () => {},
    get: (service) => (service === 'configEditor' ? (editor as unknown) : undefined),
    inject: (services, callback) => {
      const sctx: Record<string, unknown> = { on: () => {}, effect: () => {} }
      if (services.includes('configEditor')) sctx.configEditor = editor
      if (services.includes('settings')) sctx.settings = { configure: () => () => {} }
      callback(sctx as never)
    },
  }

  const settings = new AwakeSettings(ctx, () => source, async () => {}, silentLogger)
  settings.attach()

  return {
    writes,
    get config() {
      return source
    },
  }
}

describe('0.1.x → 新格式迁移', () => {
  it('默认旧配置 → mode 平台默认 + config.why', async () => {
    const h = makeHarness({ enabled: true, shellWakeLock: true, powerCfgWakeLock: false, webWakeLock: true, why: '我的原因' })
    // attach 内 apply 是异步的；跑一轮微任务等它落定。
    await new Promise((r) => setTimeout(r, 0))
    expect(h.writes).toHaveLength(1)
    const section = h.writes[0]!
    expect(section.version).toBe(CONFIG_VERSION)
    expect(section.platform).toBe('linux')
    expect(section.mode).toBe('systemd') // 平台默认
    expect(section.config).toEqual({ why: '我的原因' })
    expect(h.config).toEqual(section)
  })

  it('只开 powerCfg → 该平台电源类实现（linux → gnome-gsettings）', async () => {
    const h = makeHarness({ enabled: true, shellWakeLock: false, powerCfgWakeLock: true, webWakeLock: true, why: '' })
    await new Promise((r) => setTimeout(r, 0))
    expect(h.writes[0]?.mode).toBe('gnome-gsettings')
    expect(h.writes[0]?.config).toEqual({}) // why 为空 → 不写
  })

  it('enabled=false → mode off', async () => {
    const h = makeHarness({ enabled: false, shellWakeLock: true, powerCfgWakeLock: false, webWakeLock: true, why: 'x' })
    await new Promise((r) => setTimeout(r, 0))
    expect(h.writes[0]?.mode).toBe('off')
  })

  it('无旧配置（空配置 / 新形状）→ 不迁移', async () => {
    const h1 = makeHarness({})
    await new Promise((r) => setTimeout(r, 0))
    expect(h1.writes).toHaveLength(0)

    const h2 = makeHarness({ version: 2, platform: 'linux', mode: 'systemd', config: { why: 'x' } })
    await new Promise((r) => setTimeout(r, 0))
    expect(h2.writes).toHaveLength(0)
  })

  it('迁移只发生一次（写回后已是新格式，无循环）', async () => {
    const h = makeHarness({ enabled: true, shellWakeLock: true, powerCfgWakeLock: false, webWakeLock: true, why: 'x' })
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
    expect(h.writes).toHaveLength(1)
  })

  it('迁移后 snapshot 按新格式解析（modeId 生效）', async () => {
    const h = makeHarness({ enabled: true, shellWakeLock: false, powerCfgWakeLock: true, webWakeLock: true, why: 'x' })
    await new Promise((r) => setTimeout(r, 0))
    expect(h.writes).toHaveLength(1)
  })
})

describe('isLegacyShape 边界', () => {
  it('空对象 / 新形状 / 非对象都不是旧配置', async () => {
    const { isLegacyShape } = await import('../src/host/settings.js')
    expect(isLegacyShape({})).toBe(false)
    expect(isLegacyShape({ version: 2 })).toBe(false)
    expect(isLegacyShape(null)).toBe(false)
    expect(isLegacyShape('x')).toBe(false)
    expect(isLegacyShape(undefined)).toBe(false)
  })
})
