/**
 * 全局状态单例：任务集合 + 状态机 + 计时 + 草稿。
 *
 * ⚠️ 为什么不用「ES Module 单例」：
 * aiot-toolkit 会把每个页面编译成各自独立的 webpack 模块表
 * （每个页面的产物 js 里都各有一份 __webpack_modules__），
 * 所以同一个 store.js 在不同页面里是两份实例，状态根本共享不了。
 * 因此实例挂在 app.ux 导出的对象上，通过 this.$app.$def 跨页面共享。
 * （已在真机验证：各页面拿到的是同一个实例）
 */
import { getItem, setItem } from './storage-old.js'
import {
  STATUS,
  STATUS_TEXT,
  STATUS_CLASS,
  MAX_TASKS,
  applyAction,
  byOrder,
  buttonAction,
  buttonLabel,
  createTask,
  elapsedOf,
  hasReached,
  markReached,
  normalizeTask,
  resetForNewDay
} from './model.js'
import { formatHMS, todayStr } from './time.js'

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

  // 写盘用「脏标记 + 串行」：写入过程中又有改动会自动再写一轮，
  // 既不会并发写同一个 key，也不会丢掉最后一次改动。
  let dirty = false
  let writing = false

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

  function flush() {
    if (!dirty) {
      writing = false
      return
    }
    dirty = false
    Promise.all([setItem(KEY_TASKS, tasks), setItem(KEY_META, meta)]).then(flush, function (e) {
      console.error('[store] 持久化失败', e)
      // 保留 dirty，下次改动会重试
      dirty = true
      writing = false
    })
  }

  function persist() {
    dirty = true
    if (writing) return
    writing = true
    flush()
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

  /**
   * 从存储装载状态。
   * ⚠️ 关键：只有**两个 key 都读成功**才覆盖内存。
   * 读失败就用现有内存继续跑 —— 否则一次临时读失败会被后续 persist()
   * 固化成永久数据丢失（真实踩过的坑：第二天冷启动任务全没了）。
   * @returns {Promise<boolean>} 是否成功装载
   */
  function loadState() {
    return Promise.all([getItem(KEY_TASKS), getItem(KEY_META)]).then(function (res) {
      const t = res[0]
      const m = res[1]
      if (!t.ok || !m.ok) {
        console.error('[store] 存储读取失败，保留内存中的现有数据，本次不覆盖也不回写',
          'tasks.ok=' + t.ok, 'meta.ok=' + m.ok)
        return false
      }

      tasks = Array.isArray(t.value) ? t.value.map(normalizeTask) : []
      meta = (m.value && typeof m.value === 'object') ? m.value : { lastDate: '', schema: SCHEMA_VERSION }
      if (typeof meta.lastDate !== 'string') meta.lastDate = ''
      meta.schema = SCHEMA_VERSION
      return true
    })
  }

  // ---------- 生命周期 ----------

  /** 冷启动调用一次；重复调用返回同一个 Promise */
  function init() {
    if (initPromise) return initPromise
    initPromise = loadState().then(function (ok) {
      const now = Date.now()
      const changed = ok ? checkDailyReset(now) : false
      started = true
      // 只有读成功过才允许回写，否则会把空数据盖到真实数据上
      if (ok && changed) persist()
      notify()
      return ok
    })
    return initPromise
  }

  /**
   * 从存储重新拉取。每个页面 onShow 都会调用：
   * 正常情况下内存就是最新（写完即落盘），这一步是廉价的一致性兜底。
   */
  function reload() {
    if (!started) return init()
    return loadState().then(function (ok) {
      const now = Date.now()
      if (ok && checkDailyReset(now)) persist()
      notify()
      return ok
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
      const reached = hasReached(t, now)

      let percent = 0
      if (t.targetMs > 0) {
        percent = Math.floor((elapsed / t.targetMs) * 100)
        if (percent > 100) percent = 100   // 进度条铺满即可，时间继续走
        if (percent < 0) percent = 0
      }

      rows.push({
        id: t.id,
        title: t.title,
        // 达标只是个展示态，不停表，所以状态文案单独覆盖
        statusText: reached ? '已达标' : (STATUS_TEXT[t.status] || '未开始'),
        statusClass: reached ? 'st-done' : (STATUS_CLASS[t.status] || 'st-idle'),
        elapsedText: formatHMS(elapsed),
        targetText: t.targetMs > 0 ? formatHMS(t.targetMs) : '--:--:--',
        percent: percent,
        reached: reached,
        btnLabel: buttonLabel(t),
        btnAction: buttonAction(t)
      })
    }
    return rows
  }

  /**
   * 推进一次：打达标标记。
   * 达标**不停表**，任务继续计时直到用户主动暂停。
   * @returns {{ completed: boolean, dayChanged: boolean }}
   */
  function tick(now) {
    const ts = now || Date.now()
    let completed = false
    // 应用在前台跨过 00:00 的情况：每秒比一次日期串，开销可忽略
    const dayChanged = checkDailyReset(ts)
    for (let i = 0; i < tasks.length; i++) {
      if (markReached(tasks[i], ts)) {
        tasks[i].updatedAt = ts
        completed = true
      }
    }
    if (completed || dayChanged) persist()
    return { completed: completed, dayChanged: dayChanged }
  }

  // ---------- 写入 ----------

  function emitAction(id, action) {
    const i = findIndex(id)
    if (i < 0) return false
    const now = Date.now()
    if (!applyAction(tasks[i], action, now)) return false
    tasks[i].updatedAt = now
    // 重置后重新计时、或目标时间很短时，顺手补一次达标标记
    markReached(tasks[i], now)
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
    markReached(tasks[i], now)
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
      const now = Date.now()
      t.title = draft.title
      t.targetMs = draft.targetMs > 0 ? draft.targetMs : 0
      t.updatedAt = now
      markReached(t, now)
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
    hasReached: hasReached,
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
