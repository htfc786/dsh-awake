/**
 * 插件详情页（「插件列表 → dsh-awake」）配置面板主组件：2.1 状态行 + 2.2 提示区
 * + 2.2 更新卡片 + 2.3 浏览器开关 + 2.4 方式选择 + 常开防休眠开关（面板底部）。
 * 打开时拉取 + 每 5s 轮询（dsh-pocket 同款）；刷新按钮 = awake.refresh。
 * 宿主额外的 owner props（`view`）由组件忽略——bundle 页只请求 `view:'page'`。
 */
import { useEffect, useRef, useState } from 'react'
import type { AwakeStatus } from '../../types.js'
import type { AwakeApi } from '../api.js'
import type { LoadState } from '../state.js'
import type { WakeLockManager } from '../wake-lock.js'
import { AlwaysOnToggle } from './AlwaysOnToggle.js'
import { BrowserWakeToggle } from './BrowserWakeToggle.js'
import { ModeSelect } from './ModeSelect.js'
import { NoticeArea } from './NoticeArea.js'
import { StatusRow } from './StatusRow.js'
import { styles } from './styles.js'
import { UpdateCard } from './UpdateCard.js'

export interface AwakeSectionProps {
  /** plugins.bundle.config 注入面。 */
  readonly api: AwakeApi
  readonly manager: WakeLockManager
  readonly t: (key: string) => string
}

const POLL_MS = 5000

export function AwakeSection({ api, manager, t }: AwakeSectionProps): React.ReactElement {
  const [load, setLoad] = useState<LoadState>({ status: 'loading' })
  const [refreshing, setRefreshing] = useState(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const loadStatus = async (refresh = false): Promise<void> => {
    try {
      const data = refresh ? await api.refresh() : await api.status()
      if (mounted.current) setLoad({ status: 'ready', data })
    } catch (err) {
      if (mounted.current) setLoad({ status: 'error', message: err instanceof Error ? err.message : String(err) })
    } finally {
      if (mounted.current) setRefreshing(false)
    }
  }

  // 打开时拉取 + 每 5s 轮询。
  useEffect(() => {
    void loadStatus()
    const timer = setInterval(() => void loadStatus(), POLL_MS)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onRefresh = (): void => {
    setRefreshing(true)
    void loadStatus(true)
  }

  const onStatus = (data: AwakeStatus): void => {
    setLoad({ status: 'ready', data })
  }

  const data = load.status === 'ready' ? load.data : null
  const loadError = load.status === 'error' ? load.message : null

  return (
    <div style={styles.card}>
      <StatusRow data={data} loadError={loadError} refreshing={refreshing} onRefresh={onRefresh} t={t} />

      {load.status === 'loading' && <div style={{ ...styles.muted, marginTop: 12 }}>{t('loading')}</div>}
      {load.status === 'error' && <div style={{ ...styles.error, marginTop: 12 }}>{t('loadError')}{loadError}</div>}

      {data !== null && (
        <>
          {/* 提示区 / 更新卡片自带色块边框，不重复画分割线；仅在出现时渲染 */}
          <NoticeArea data={data} t={t} />
          <UpdateCard data={data} api={api} t={t} />
          <div style={styles.block}>
            <BrowserWakeToggle manager={manager} t={t} />
          </div>
          <ModeSelect data={data} api={api} onStatus={onStatus} t={t} />
          {/* 常开防休眠：页面最底部的一键开关（无论是否有任务都值守） */}
          <AlwaysOnToggle data={data} api={api} onStatus={onStatus} t={t} />
        </>
      )}
    </div>
  )
}
