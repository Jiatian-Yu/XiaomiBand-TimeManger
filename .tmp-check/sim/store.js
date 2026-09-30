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
import { getItem, setItem } from './storage.js'
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
import { formatHMS, isEarlierDay, todayStr } from './time.js'

/**
 * ⚠️ 持久化只写这一个 key（原子）：tasks 和 lastDate 在同一份快照里，
 * 不可能互相矛盾，也不会出现半截状态。别再拆成两个 key —— 曾经拆过，
 * 手环上同一 tick 并发写第二个 key 会失败 → lastDate 永远为空 →
 * 每次冷启动都被判成「跨天」→ 累积时间被清空（真实踩过的 bug）。
 */
const KEY_STATE = 'tm.state'
const SCHEMA_VERSION = 2

/** 写盘失败后的重试节奏：失败说明数据没落地，值得重试几次 */
const RETRY_DELAY = 3000
const MAX_RETRY = 5

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
  let retryTimer = null
  let retryCount = 0
  // 本地改动计数器：读取是异步的，若读回来的旧快照会盖掉刚发生的改动就丢弃它
  let revision = 0
  // 是否成功看过存储里的内容。没看过时写盘 = 拿内存（可能还是空的）去覆盖
  // 磁盘上读不出来的真实数据，所以装载成功前一律不写，改为重试「读」（见 scheduleLoadRetry）。
  let loaded = false
  let loadRetryTimer = null

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

  function scheduleRetry() {
    if (retryTimer || typeof setTimeout !== 'function') return
    retryTimer = setTimeout(function () {
      retryTimer = null
      writeNow()
    }, RETRY_DELAY)
  }

  /**
   * 还没成功装载过存储时，写盘的替代方案：不写，改为按节奏重试「读」。
   * 读到之后磁盘内容就已知了，writeNow 才会真的落盘。
   * 读一直失败就一直重试：代价只是内存里的改动暂时不落地，
   * 总好过拿一份不知道覆盖了什么的快照去写盘。
   */
  function scheduleLoadRetry() {
    if (loadRetryTimer || typeof setTimeout !== 'function') return
    loadRetryTimer = setTimeout(function () {
      loadRetryTimer = null
      if (loaded) {
        // 这期间别的路径（页面 onShow 的 reload）已经装载成功，把攒下的改动补写掉
        writeNow()
        return
      }
      reload().then(function (ok) {
        if (!ok) scheduleLoadRetry()
      })
    }, RETRY_DELAY)
  }

  function flush() {
    if (!dirty) {
      writing = false
      return
    }
    dirty = false
    // 整体快照一次写入：tasks 和 lastDate 永远同进同退
    const snapshot = { schema: SCHEMA_VERSION, lastDate: meta.lastDate, tasks: tasks }
    setItem(KEY_STATE, snapshot).then(function (ok) {
      if (!ok) {
        // 写失败 = 这次的状态没落地，保留 dirty 并重试，绝不当成成功
        dirty = true
        writing = false
        if (retryCount < MAX_RETRY) {
          retryCount++
          console.error('[store] 持久化失败，' + RETRY_DELAY + 'ms 后重试（第 ' + retryCount + ' 次）')
          scheduleRetry()
        } else {
          console.error('[store] 持久化连续失败，放弃重试（数据仍在内存里）')
        }
        return
      }
      retryCount = 0
      flush()
    })
  }

  /** 用户可见的状态变了：记一次改动 + 落盘（每次改动都重新给足重试预算） */
  function persist() {
    revision++
    retryCount = 0
    writeNow()
  }

  /** 单纯把当前状态写下去；重试定时器也走这里，所以它不重置重试预算 */
  function writeNow() {
    dirty = true
    if (!loaded) {
      // 还没成功看过存储内容：此刻写盘等于拿内存覆盖未知数据。只记脏，改为重试读。
      scheduleLoadRetry()
      return
    }
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
   *
   * ⚠️ 铁律：只有在**存储里的日期确实早于今天**时才清数据。
   * lastDate 为空（首次启动 / 元数据丢失）、解析不出来、或比今天还晚（时钟回拨）
   * 时，一律只把日期对齐到今天，**一个任务都不动**。
   * 宁可漏掉一次跨天重置，也绝不能把用户累积的时间白白清掉 —— 这正是之前
   * 「关掉再打开时间就没了」的成因：lastDate 写不进去 → 每次冷启动都被当成新的一天。
   *
   * @returns {boolean} 是否发生了需要落盘的日期变化
   */
  function checkDailyReset(now) {
    const today = todayStr()
    const prev = meta.lastDate
    if (prev === today) return false
    meta.lastDate = today
    if (!isEarlierDay(prev, today)) {
      if (tasks.length > 0) {
        console.warn('[store] 跳过跨天重置：存储里的日期不可信 lastDate=' + JSON.stringify(prev))
      }
      return true
    }
    console.log('[store] 跨天重置 ' + prev + ' → ' + today + '（' + tasks.length + ' 个任务）')
    for (let i = 0; i < tasks.length; i++) {
      resetForNewDay(tasks[i], now)
    }
    return true
  }

  /** 用存储里的内容覆盖内存（只有确认读成功时才能调用） */
  function applyState(rawTasks, rawLastDate) {
    tasks = Array.isArray(rawTasks) ? rawTasks.map(normalizeTask) : []
    meta = {
      lastDate: typeof rawLastDate === 'string' ? rawLastDate : '',
      schema: SCHEMA_VERSION
    }
  }

  /**
   * 首次装载成功时的合并（只有 loaded === false 才会走到这里）。
   * 为什么不直接 applyState：装载成功前用户能做的只有「新增任务」
   * （列表是空的，改 / 删 / 排序都无从谈起），内存里全是一直没读到的磁盘快照
   * **之后**新增的任务；而磁盘上是那段读失败时间里我们看不到的旧数据。
   * 用磁盘覆盖会丢掉新增，直接写盘会毁掉旧数据 —— 两边都不能丢，按 id 合并。
   * lastDate 取磁盘的：它更旧，跨天判据宁可漏一次也不会清掉任何人的时间。
   */
  function mergeLoaded(rawTasks, rawLastDate) {
    const disk = Array.isArray(rawTasks) ? rawTasks.map(normalizeTask) : []
    const seen = {}
    let maxOrder = -1
    for (let i = 0; i < disk.length; i++) {
      seen[disk[i].id] = true
      if (disk[i].order > maxOrder) maxOrder = disk[i].order
    }
    const local = []
    for (let i = 0; i < tasks.length; i++) {
      // 同 id 只可能是磁盘那份更早（id 里带创建时间戳），留磁盘的
      if (seen[tasks[i].id]) continue
      tasks[i].order = maxOrder + 1 + local.length   // 排在磁盘任务后面，顺序稳定
      local.push(tasks[i])
    }
    tasks = disk.concat(local)
    meta = {
      lastDate: typeof rawLastDate === 'string' ? rawLastDate : '',
      schema: SCHEMA_VERSION
    }
  }

  /**
   * 从存储装载状态。
   * ⚠️ 铁律：只有**读取成功**才覆盖内存。读失败就保留现有内存、也绝不回写，
   * 否则一次临时读失败会被后续 persist() 固化成永久数据丢失。
   *
   * 两个容易漏掉的时机问题：
   * 1. 本地还有没落盘的改动（dirty / writing / retryTimer）时，磁盘里一定是旧快照，
   *    读回来只会把内存里的新改动盖掉 —— 直接跳过这次读取。
   * 2. 第一次成功读取之前，内存里是用户在这段「读不到存储」的时间里新增的任务，
   *    磁盘上则是读不出来的旧数据 —— 按 id 合并，不覆盖（见 mergeLoaded）。
   * @returns {Promise<boolean>} 是否成功装载
   */
  function loadState() {
    if (loaded && (dirty || writing || retryTimer)) {
      console.warn('[store] 本地还有未落盘的改动，跳过这次读取（内存比磁盘新）')
      return Promise.resolve(false)
    }
    const rev = revision
    return getItem(KEY_STATE).then(function (res) {
      if (revision !== rev) {
        // 读取期间用户已经改了数据，别用读回来的旧快照盖掉它
        console.warn('[store] 读取期间发生本地改动，丢弃这次快照')
        return false
      }
      // res.corrupt（有值但解析不了）不算读取失败：磁盘上是一份没法用的数据，
      // 虽然不能拿来用，但可以放心覆盖，所以照样置 loaded。
      if (!res.ok && !res.corrupt) {
        console.error('[store] 存储读取失败，保留内存中的现有数据，本次不覆盖也不回写')
        return false
      }
      if (res.corrupt) {
        console.error('[store] 存储内容解析失败，保留内存中的现有数据，允许后续覆盖')
        loaded = true
        if (dirty) writeNow()
        return false
      }
      if (res.value === null || res.value === undefined) {
        // key 还不存在 = 首次启动（Vela 里读不存在的 key 走 success 返回默认值）
        if (loaded) applyState([], '')
        else mergeLoaded([], '')
        loaded = true
        if (dirty) writeNow()   // 装载前攒下的改动，现在可以安全落盘了
        return true
      }
      if (typeof res.value === 'object' && Array.isArray(res.value.tasks)) {
        if (loaded) applyState(res.value.tasks, res.value.lastDate)
        else mergeLoaded(res.value.tasks, res.value.lastDate)
        loaded = true
        if (dirty) writeNow()
        return true
      }
      // 有内容但不是认识的形状：按损坏处理。保留内存，但允许后续覆盖它
      console.error('[store] 存储内容形状异常，保留内存中的现有数据，允许后续覆盖')
      loaded = true
      if (dirty) writeNow()
      return false
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
      const changed = ok ? checkDailyReset(now) : false
      if (ok && changed) persist()
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
