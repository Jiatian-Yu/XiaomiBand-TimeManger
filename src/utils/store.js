/**
 * 全局状态单例：任务集合 + 状态机 + 计时 + 草稿。
 *
 * 为什么不用「ES Module 单例」：
 * aiot-toolkit 会把每个页面编译成各自独立的 webpack 模块表
 * （每个页面的产物 js 里都各有一份 __webpack_modules__），
 * 所以同一个 store.js 在不同页面里是两份实例，状态根本共享不了。
 * 因此实例挂在 app.ux 导出的对象上，通过 this.$app.$def 跨页面共享。
 */
import { getItem, setItem } from './storage'
import {
  STATUS,
  STATUS_TEXT,
  STATUS_CLASS,
  MAX_TASKS,
  applyAction,
  byOrder,
  buttonAction,
  buttonLabel,
  checkComplete,
  createTask,
  elapsedOf,
  normalizeTask,
  resetForNewDay
} from './model'
import { formatHMS, todayStr } from './time'

const KEY_TASKS = 'tm.tasks'
const KEY_META = 'tm.meta'
const SCHEMA_VERSION = 1

export function createStore() {
  let tasks = []
  let meta = { lastDate: '', schema: SCHEMA_VERSION }
  let draft = null
  let listeners = []
  let started = false
  let initPromise = null

  // ---------- 内部工具 ----------

  function notify() {
    for (let i = 0; i < listeners.length; i++) {
      try {
        listeners[i]()
      } catch (e) {
        console.error('[store] 订阅回调异常', e)
      }
    }
  }

  function persist() {
    setItem(KEY_TASKS, tasks)
    setItem(KEY_META, meta)
  }

  function findIndex(id) {
    for (let i = 0; i < tasks.length; i++) {
      if (tasks[i].id === id) return i
    }
    return -1
  }

  /**
   * 惰性跨天重置：手环不可能保证 00:00 时应用在运行，
   * 所以不做定时任务，而是「谁先发现谁重置」。
   * @returns {boolean} 是否执行了重置
   */
  function checkDailyReset(now) {
    const today = todayStr()
    if (meta.lastDate === today) return false
    for (let i = 0; i < tasks.length; i++) {
      resetForNewDay(tasks[i], now)
    }
    meta.lastDate = today
    return true
  }

  function hydrate(rawTasks, rawMeta) {
    const list = Array.isArray(rawTasks) ? rawTasks : []
    tasks = list.map(normalizeTask)
    meta = rawMeta && typeof rawMeta === 'object' ? rawMeta : { lastDate: '', schema: SCHEMA_VERSION }
    if (typeof meta.lastDate !== 'string') meta.lastDate = ''
    meta.schema = SCHEMA_VERSION
  }

  // ---------- 生命周期 ----------

  /** 冷启动调用一次；重复调用返回同一个 Promise */
  function init() {
    if (initPromise) return initPromise
    initPromise = Promise.all([getItem(KEY_TASKS, []), getItem(KEY_META, null)]).then(function (res) {
      hydrate(res[0], res[1])
      const now = Date.now()
      const changed = checkDailyReset(now)
      started = true
      if (changed) persist()
      notify()
      return true
    })
    return initPromise
  }

  /**
   * 从存储重新拉取。每个页面 onShow 都会调用：
   * 正常情况下内存就是最新（写完即落盘），这一步是廉价的一致性兜底。
   */
  function reload() {
    if (!started) return init()
    return Promise.all([getItem(KEY_TASKS, []), getItem(KEY_META, null)]).then(function (res) {
      hydrate(res[0], res[1])
      const now = Date.now()
      if (checkDailyReset(now)) persist()
      notify()
      return true
    })
  }

  // ---------- 读取 ----------

  function getTasks() {
    return tasks.slice().sort(byOrder)
  }

  function getTask(id) {
    const i = findIndex(id)
    return i < 0 ? null : tasks[i]
  }

  function count() {
    return tasks.length
  }

  /** 是否有任务正在计时（决定要不要起 1s 定时器） */
  function hasRunning() {
    for (let i = 0; i < tasks.length; i++) {
      if (tasks[i].status === STATUS.RUNNING) return true
    }
    return false
  }

  /**
   * 生成给视图用的行数据（全部是已完成格式化的字符串/数字，
   * 因为快应用模板里不能调用方法）。
   */
  function buildRows(now) {
    const list = getTasks()
    const rows = []
    for (let i = 0; i < list.length; i++) {
      const t = list[i]
      const elapsed = elapsedOf(t, now)
      let percent = 0
      if (t.targetMs > 0) {
        percent = Math.floor((elapsed / t.targetMs) * 100)
        if (percent > 100) percent = 100
        if (percent < 0) percent = 0
      }
      rows.push({
        id: t.id,
        title: t.title,
        statusText: STATUS_TEXT[t.status] || '未开始',
        statusClass: STATUS_CLASS[t.status] || 'st-idle',
        elapsedText: formatHMS(elapsed),
        targetText: t.targetMs > 0 ? formatHMS(t.targetMs) : '--:--:--',
        percent: percent,
        done: t.status === STATUS.DONE,
        btnLabel: buttonLabel(t),
        btnAction: buttonAction(t)
      })
    }
    return rows
  }

  /**
   * 推进一次：算达标、必要时落盘。
   * @returns {boolean} 是否有任务刚刚完成（用于触发振动）
   */
  function tick(now) {
    const ts = now || Date.now()
    let completed = false
    // 应用在前台跨过 00:00 的情况：每秒比一次日期串，开销可忽略
    const dayChanged = checkDailyReset(ts)
    for (let i = 0; i < tasks.length; i++) {
      if (checkComplete(tasks[i], ts)) {
        tasks[i].updatedAt = ts
        completed = true
      }
    }
    if (completed || dayChanged) persist()
    // 跨天重置后不该再有任务在跑
    return { completed: completed, dayChanged: dayChanged }
  }

  // ---------- 写入 ----------

  function emitAction(id, action) {
    const i = findIndex(id)
    if (i < 0) return false
    const now = Date.now()
    if (!applyAction(tasks[i], action, now)) return false
    tasks[i].updatedAt = now
    // 开始/继续后可能已经达标（目标极短），顺手检测一次
    checkComplete(tasks[i], now)
    persist()
    notify()
    return true
  }

  function addTask(title, targetMs) {
    if (tasks.length >= MAX_TASKS) return { ok: false, reason: 'limit' }
    const trimmed = (title || '').trim()
    if (!trimmed) return { ok: false, reason: 'empty' }
    let maxOrder = -1
    for (let i = 0; i < tasks.length; i++) {
      if (tasks[i].order > maxOrder) maxOrder = tasks[i].order
    }
    const task = createTask(trimmed, targetMs, maxOrder + 1)
    tasks.push(task)
    persist()
    notify()
    return { ok: true, task: task }
  }

  function updateTitle(id, title) {
    const i = findIndex(id)
    if (i < 0) return false
    const trimmed = (title || '').trim()
    if (!trimmed) return false
    tasks[i].title = trimmed
    tasks[i].updatedAt = Date.now()
    persist()
    notify()
    return true
  }

  function updateTarget(id, targetMs) {
    const i = findIndex(id)
    if (i < 0) return false
    const now = Date.now()
    tasks[i].targetMs = targetMs > 0 ? targetMs : 0
    tasks[i].updatedAt = now
    // 目标改小后可能立刻达标
    checkComplete(tasks[i], now)
    persist()
    notify()
    return true
  }

  function removeTask(id) {
    const i = findIndex(id)
    if (i < 0) return false
    tasks.splice(i, 1)
    persist()
    notify()
    return true
  }

  // ---------- 草稿 ----------
  // 新建任务要跨「标题页 → 目标时间页」两个页面，编辑任务要保证
  // 「取消」能整体回退，所以标题和目标时间都先落在草稿上，最后一起提交。

  function beginCreate() {
    draft = { mode: 'create', id: null, title: '', targetMs: 0 }
    return draft
  }

  function beginEdit(id) {
    const t = getTask(id)
    if (!t) return null
    draft = { mode: 'edit', id: t.id, title: t.title, targetMs: t.targetMs }
    return draft
  }

  function getDraft() {
    return draft
  }

  function setDraftTitle(title) {
    if (!draft) return false
    draft.title = (title || '').trim()
    return true
  }

  /** 提交草稿。targetMs 传入时会覆盖草稿里的目标时间。 */
  function commitDraft(targetMs) {
    if (!draft) return { ok: false, reason: 'no-draft' }
    if (typeof targetMs === 'number') draft.targetMs = targetMs
    if (!draft.title) {
      draft = null
      return { ok: false, reason: 'empty' }
    }
    let result
    if (draft.mode === 'edit') {
      const t = getTask(draft.id)
      if (!t) {
        draft = null
        return { ok: false, reason: 'missing' }
      }
      t.title = draft.title
      t.targetMs = draft.targetMs > 0 ? draft.targetMs : 0
      t.updatedAt = Date.now()
      checkComplete(t, Date.now())
      persist()
      notify()
      result = { ok: true, task: t }
    } else {
      result = addTask(draft.title, draft.targetMs)
    }
    draft = null
    return result
  }

  function discardDraft() {
    draft = null
  }

  // ---------- 订阅 ----------

  function subscribe(fn) {
    listeners.push(fn)
    return function unsubscribe() {
      const i = listeners.indexOf(fn)
      if (i >= 0) listeners.splice(i, 1)
    }
  }

  return {
    init: init,
    reload: reload,
    getTasks: getTasks,
    getTask: getTask,
    count: count,
    hasRunning: hasRunning,
    buildRows: buildRows,
    tick: tick,
    elapsedOf: elapsedOf,
    emitAction: emitAction,
    addTask: addTask,
    updateTitle: updateTitle,
    updateTarget: updateTarget,
    removeTask: removeTask,
    beginCreate: beginCreate,
    beginEdit: beginEdit,
    getDraft: getDraft,
    setDraftTitle: setDraftTitle,
    commitDraft: commitDraft,
    discardDraft: discardDraft,
    subscribe: subscribe
  }
}

// 兜底实例：只有在拿不到 $app.$def 时才会用到
let localStore = null

/**
 * 页面里统一这样拿 store：const store = useStore(this)
 * 优先挂在 app.ux 导出的对象上（跨页面同一实例），拿不到才退回模块级实例。
 */
export function useStore(vm) {
  const appDef = vm && vm.$app && vm.$app.$def
  if (appDef) {
    if (!appDef.store) {
      appDef.store = createStore()
      appDef.store.init()
    }
    return appDef.store
  }
  console.error('[store] 取不到 $app.$def，退回页面内实例（跨页面共享会失效）')
  if (!localStore) {
    localStore = createStore()
    localStore.init()
  }
  return localStore
}

export { STATUS, STATUS_TEXT }
