/**
 * R1 / R2 两个「装载时机」问题的回归用例。
 * 修复前跑应该看到 R1/R2 的 ❌（磁盘旧快照回滚内存 / 读失败时把内存写回磁盘毁掉真实数据），
 * 修复后应全 ✅。
 */
import { createStore } from './sim/store.js'
import { elapsedOf } from './sim/model.js'

let fakeNow = Date.now()
const realNow = Date.now
Date.now = () => fakeNow
const tick = (ms) => new Promise((r) => setTimeout(r, ms))
globalThis.__TOASTS__ = []

function makeStorage(opts = {}) {
  const data = {}
  return {
    data,
    opts,
    get({ key, default: def, success, fail, complete }) {
      setTimeout(() => {
        if (opts.readFails) fail(null, 400)
        else success(key in data ? data[key] : def)
        complete && complete()
      }, 0)
    },
    set({ key, value, success, fail, complete }) {
      if (opts.failNextSet || opts.setFails) {
        opts.failNextSet = false
        setTimeout(() => { fail(null, 500); complete && complete() }, 0)
        return
      }
      const delay = opts.setDelay || 0
      setTimeout(() => {
        data[key] = value
        success()
        complete && complete()
      }, delay)
    },
    delete({ key, success, complete }) {
      delete data[key]
      setTimeout(() => { success(); complete && complete() }, 0)
    }
  }
}

async function boot(storage) {
  globalThis.__MOCK_STORAGE__ = storage
  const store = createStore()
  await store.init()
  await tick(20)
  return store
}

const today = (function () {
  const d = new Date()
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate()
})()
const snapshot = (tasks) => JSON.stringify({ schema: 2, lastDate: today, tasks })

const BOOK = {
  id: 't_book', title: '看书', targetMs: 3600000, accumulatedMs: 5000, runningSince: null,
  reachedAt: null, status: 'paused', order: 0, createdAt: 1, updatedAt: 1
}

const titles = (store) => store.getTasks().map((t) => t.title).join(',') || '(空)'
const diskTitles = (storage) => {
  const raw = storage.data['tm.state']
  if (!raw) return '(无)'
  return (((JSON.parse(raw)).tasks) || []).map((t) => t.title).join(',') || '(空)'
}
const diskTask0 = (storage) => (JSON.parse(storage.data['tm.state'])).tasks[0]

let fails = 0
function check(label, ok) {
  console.log('   ' + (ok ? '✅' : '❌') + ' ' + label)
  if (!ok) fails++
}

// ---------------------------------------------------------------- R1a
console.log('\n===== R1a 写失败后 reload() 不得用磁盘旧快照回滚内存 =====')
{
  const storage = makeStorage({})
  const store = await boot(storage)
  const r = store.addTask('跑步', 3600000).task
  await tick(20)
  store.emitAction(r.id, 'start')
  await tick(20)
  fakeNow += 3000
  storage.opts.failNextSet = true          // 让「暂停」这次写失败 → 内存留下未落盘的改动
  store.emitAction(r.id, 'pause')
  await tick(20)

  check('前提：磁盘还是旧状态 running', diskTask0(storage).status === 'running')
  const mem = store.getTasks()[0]
  check('前提：内存已是新状态 paused + 3 秒', mem.status === 'paused' && mem.accumulatedMs === 3000)

  await store.reload()                     // 页面 onShow 触发
  await tick(20)
  const after = store.getTasks()[0]
  check('reload 后内存没被回滚', after.status === 'paused' && after.accumulatedMs === 3000)

  await tick(3500)                         // 等写重试
  check('改动最终还是落了盘', diskTask0(storage).status === 'paused' && diskTask0(storage).accumulatedMs === 3000)
}

// ---------------------------------------------------------------- R1b
console.log('\n===== R1b 写入还在途中时 reload() 不得回滚内存 =====')
{
  const storage = makeStorage({})
  const store = await boot(storage)
  const r = store.addTask('跑步', 3600000).task
  await tick(20)
  store.emitAction(r.id, 'start')
  await tick(20)
  storage.opts.setDelay = 150              // 之后的写要 150ms 才落盘
  fakeNow += 3000
  store.emitAction(r.id, 'pause')          // 写在途中
  await store.reload()                     // 读比写先回来
  await tick(20)
  const mem = store.getTasks()[0]
  check('reload 后内存没被回滚', mem.status === 'paused' && mem.accumulatedMs === 3000)

  await tick(200)                          // 等写落盘
  check('写最终落了盘', diskTask0(storage).status === 'paused' && diskTask0(storage).accumulatedMs === 3000)
}

// ---------------------------------------------------------------- R2a
console.log('\n===== R2a 装载成功前不得写盘；读恢复后合并而非覆盖 =====')
{
  const storage = makeStorage({ readFails: true })
  storage.data['tm.state'] = snapshot([BOOK])   // 磁盘上的真实数据，这次读不出来
  const store = await boot(storage)
  check('启动时读失败 → 列表为空', store.getTasks().length === 0)

  store.addTask('阅读', 3600000)               // 用户新增
  await tick(20)
  check('新增没有写盘（磁盘旧数据完好）', diskTitles(storage) === '看书')

  await store.reload()                         // 读还是坏的，用户切了页面
  await tick(20)
  check('读仍失败时 reload 不覆盖内存', titles(store) === '阅读')

  storage.opts.readFails = false               // 存储恢复
  await tick(3500)                             // 等装载重试
  check('恢复后内存 = 磁盘旧数据 + 新增', titles(store) === '看书,阅读')
  check('恢复后两边都落盘', diskTitles(storage) === '看书,阅读')
  const book = store.getTasks()[0]
  check('旧任务的累积时间没丢', book.title === '看书' && elapsedOf(book, Date.now()) === 5000)
}

// ---------------------------------------------------------------- R2b
console.log('\n===== R2b 读持续失败：磁盘数据纹丝不动，恢复后杀掉重开都还在 =====')
{
  const storage = makeStorage({ readFails: true })
  storage.data['tm.state'] = snapshot([BOOK])
  let store = await boot(storage)
  store.addTask('阅读', 3600000)
  await tick(20)

  await tick(4000)                             // 期间装载重试跑了至少一轮，仍然读不到
  check('重试期间磁盘没被写坏', diskTitles(storage) === '看书')
  check('内存里的新增还在（只是暂时不落盘）', titles(store) === '阅读')

  storage.opts.readFails = false               // 存储恢复
  await tick(3500)
  check('恢复后合并落盘', titles(store) === '看书,阅读' && diskTitles(storage) === '看书,阅读')

  store = null                                 // 杀掉进程（此时没有 pending 定时器）
  await tick(50)
  const store2 = await boot(storage)
  check('重开后数据都在', titles(store2) === '看书,阅读')
  store2.addTask('冥想', 3600000)
  await tick(20)
  check('重开后写盘正常', diskTitles(storage) === '看书,阅读,冥想')
}

Date.now = realNow
console.log('\n' + (fails === 0 ? '全部通过 ✅' : fails + ' 条断言失败 ❌'))
process.exitCode = fails === 0 ? 0 : 1
