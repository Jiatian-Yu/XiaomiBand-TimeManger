/**
 * 数据模型、状态机与纯函数。
 * 本文件不依赖任何平台 API，可脱离快应用环境单独测试。
 */

/** 内部状态。paused 对用户仍展示为「进行中」，只是按钮文案不同。 */
export const STATUS = {
  IDLE: 'idle',
  RUNNING: 'running',
  PAUSED: 'paused',
  /** @deprecated 达标不再停表，此状态已废弃，仅用于识别并迁移旧数据 */
  DONE: 'done'
}

/** 状态展示文案 */
export const STATUS_TEXT = {
  idle: '未开始',
  running: '进行中',
  paused: '进行中',
  done: '已达标'
}

/** 状态对应的样式类 */
export const STATUS_CLASS = {
  idle: 'st-idle',
  running: 'st-running',
  paused: 'st-paused',
  done: 'st-done'
}

/** 主按钮在不同状态下的动作 */
const BUTTON_BY_STATUS = {
  idle: { label: '开始', action: 'start' },
  running: { label: '暂停', action: 'pause' },
  paused: { label: '继续', action: 'resume' }
}

export const MAX_TASKS = 20
export const MAX_TITLE_LEN = 12

export function buttonLabel(task) {
  const b = BUTTON_BY_STATUS[task.status]
  return b ? b.label : '开始'
}

export function buttonAction(task) {
  const b = BUTTON_BY_STATUS[task.status]
  return b ? b.action : 'start'
}

/**
 * 实时已坚持毫秒。running 时用「时间戳差值」算，因此中途完全不写存储，
 * 应用被切走/杀掉后回到前台依然准确。
 */
export function elapsedOf(task, now) {
  const base = task.accumulatedMs || 0
  if (task.status === STATUS.RUNNING && task.runningSince) {
    const delta = now - task.runningSince
    return base + (delta > 0 ? delta : 0)
  }
  return base
}

/**
 * 是否已达标。目标为 0 时视作纯秒表，永远不算达标。
 * 纯查询，不改任何状态。
 */
export function hasReached(task, now) {
  if (!task.targetMs || task.targetMs <= 0) return false
  return elapsedOf(task, now) >= task.targetMs
}

/**
 * 首次达标时打个标记，用于触发一次振动。
 * 达标**不停表**，任务会继续计时，直到用户主动暂停（产品要求）。
 * @returns {boolean} 是否刚刚首次达标
 */
export function markReached(task, now) {
  if (task.reachedAt) return false
  if (!hasReached(task, now)) return false
  task.reachedAt = now
  return true
}

/**
 * 状态机唯一入口：所有状态迁移都必须走这里，禁止页面直接改 task.status。
 * @returns {boolean} 是否发生了状态变化
 */
export function applyAction(task, action, now) {
  switch (action) {
    case 'start':
      if (task.status !== STATUS.IDLE) return false
      task.runningSince = now
      task.status = STATUS.RUNNING
      return true

    case 'pause':
      if (task.status !== STATUS.RUNNING) return false
      task.accumulatedMs = elapsedOf(task, now)
      task.runningSince = null
      task.status = STATUS.PAUSED
      return true

    case 'resume':
      if (task.status !== STATUS.PAUSED) return false
      task.runningSince = now
      task.status = STATUS.RUNNING
      return true

    case 'reset':
      if (task.status === STATUS.IDLE && !task.accumulatedMs && !task.runningSince && !task.reachedAt) {
        return false
      }
      task.accumulatedMs = 0
      task.runningSince = null
      task.reachedAt = null
      task.status = STATUS.IDLE
      return true

    default:
      return false
  }
}

/** 跨天重置单个任务 */
export function resetForNewDay(task, now) {
  task.accumulatedMs = 0
  task.runningSince = null
  task.reachedAt = null
  task.status = STATUS.IDLE
  task.updatedAt = now
}

let seq = 0

export function createTask(title, targetMs, order) {
  const now = Date.now()
  seq = (seq + 1) % 1000
  return {
    id: 't_' + now + '_' + seq,
    title: title,
    targetMs: targetMs > 0 ? targetMs : 0,
    accumulatedMs: 0,
    runningSince: null,
    reachedAt: null,
    status: STATUS.IDLE,
    order: order || 0,
    createdAt: now,
    updatedAt: now
  }
}

/** 修复历史数据里缺失/类型不对的字段 */
export function normalizeTask(raw) {
  const task = raw || {}
  if (typeof task.id !== 'string' || !task.id) task.id = 't_' + Date.now() + '_x'
  if (typeof task.title !== 'string') task.title = '未命名'
  if (typeof task.targetMs !== 'number' || task.targetMs < 0) task.targetMs = 0
  if (typeof task.accumulatedMs !== 'number' || task.accumulatedMs < 0) task.accumulatedMs = 0
  if (typeof task.runningSince !== 'number') task.runningSince = null
  if (typeof task.reachedAt !== 'number') task.reachedAt = null
  if (typeof task.order !== 'number') task.order = 0

  // 旧版本达标会置为 done 并停表；现在达标不停表，迁移成 paused 让用户能继续
  if (task.status === STATUS.DONE) {
    task.status = STATUS.PAUSED
    task.runningSince = null
  }
  if (!BUTTON_BY_STATUS[task.status] && task.status !== STATUS.IDLE) {
    task.status = STATUS.IDLE
    task.runningSince = null
  }
  return task
}

export function byOrder(a, b) {
  return (a.order || 0) - (b.order || 0)
}
