/**
 * 用假的 @system.storage 跑 store 逻辑，复现「关掉再打开时间归零」。
 * 假 storage 的行为可配置，用来模拟几种可能的平台差异。
 */
import { createStore } from './sim/store.js'
import { elapsedOf } from './sim/model.js'
import { formatHMS } from './sim/time.js'

let fakeNow = Date.now()
const realNow = Date.now
Date.now = () => fakeNow

const tick = (ms) => new Promise((r) => setTimeout(r, ms))

function makeStorage(opts = {}) {
  const data = {}
  let setCalls = 0
  return {
    data,
    get({ key, default: def, success, fail, complete }) {
      setTimeout(() => {
        if (opts.readFails) {
          fail(null, 400)
        } else {
          success(key in data ? data[key] : def)   // Vela: 不存在也走 success
        }
        complete && complete()                     // complete 永远最后来
      }, 0)
    },
    set({ key, value, success, fail, complete }) {
      setCalls++
      // 第一次写只报「结束」不报「结果」，之后恢复正常
      if (opts.completeOnlyFirst && setCalls === 1) {
        setTimeout(() => complete && complete(), 0)
        return
      }
      if (opts.writeFails) {
        setTimeout(() => { fail(null, 500); complete && complete() }, 0)
        return
      }
      data[key] = value
      setTimeout(() => { success(); complete && complete() }, 0)
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
  await tick(10)
  return store
}

function dump(label, store) {
  const rows = store.buildRows(Date.now())
  const raw = Object.keys(globalThis.__MOCK_STORAGE__.data)
    .map((k) => k + '=' + globalThis.__MOCK_STORAGE__.data[k].slice(0, 120))
    .join('\n    ')
  console.log(
    label,
    '\n    rows:', rows.length === 0 ? '(空列表)' : rows.map((r) => `${r.title} ${r.elapsedText} ${r.statusText}`).join(' | '),
    '\n    存储:', raw || '(空)'
  )
}

async function scenario(name, opts) {
  console.log('\n========== ' + name + ' ==========')
  const storage = makeStorage(opts)

  // ---- 第一次启动：加任务 → 开始 → 等 5 秒 → 暂停 ----
  let store = await boot(storage)
  const r = store.addTask('看书', 3600000)
  await tick(10)
  store.emitAction(r.task.id, 'start')
  await tick(10)
  fakeNow += 5000
  store.emitAction(r.task.id, 'pause')
  await tick(10)
  dump('暂停后（内存）:', store)

  // ---- 退出软件：丢掉实例，模拟进程被杀 ----
  store = null
  await tick(50)

  // ---- 再打开 ----
  const store2 = await boot(storage)
  dump('重开后:', store2)
  const t = store2.getTasks()[0]
  if (t) {
    const secs = elapsedOf(t, Date.now()) / 1000
    console.log('  ==> 坚持时间:', formatHMS(elapsedOf(t, Date.now())), secs === 5 ? '✅ 保住了' : '❌ 丢了')
  } else {
    console.log('  ==> ❌ 任务都没了')
  }
}

await scenario('S1 平台正常', {})

// S2: 第一次 set 只回调 complete、没有 success/fail。
// 老代码只认 success/fail → Promise 永远 pending → store 的 writing 卡死 → 之后写盘静默失效。
// 新代码在 complete 里看到「结束了却没有结论」→ 按失败处理 → 走既有重试路径。
console.log('\n========== S2 只收到 complete（无 success/fail）==========')
{
  const storage = makeStorage({ completeOnlyFirst: true })
  const store = await boot(storage)
  console.log('  第一次写后磁盘:', 'tm.state' in storage.data ? '有' : '(空) ← 这次写没落盘')
  await tick(3500)   // 等 store 的 3 秒重试
  console.log('  ==> 自动重试:', 'tm.state' in storage.data ? '✅ 补写成功，写盘没卡死' : '❌ 还是空的，卡死了')
  store.addTask('看书', 3600000)
  await tick(20)
  const onDisk = (JSON.parse(storage.data['tm.state'] || '{}').tasks) || []
  console.log('  ==> 后续写入:', onDisk.length === 1 ? '✅ 正常落盘' : '❌ 没落盘')
}

// S3: 存储里还留着旧版本的 tm.tasks / tm.meta —— 新代码应完全忽略它们
console.log('\n========== S3 旧版本遗留 key 应被忽略 ==========')
{
  const storage = makeStorage({})
  storage.data['tm.tasks'] = JSON.stringify([
    { id: 't_old', title: '看书', targetMs: 3600000, accumulatedMs: 42000, runningSince: null,
      reachedAt: null, status: 'paused', order: 0, createdAt: 1, updatedAt: 1 }
  ])
  storage.data['tm.meta'] = JSON.stringify({ lastDate: '', schema: 1 })
  const store = await boot(storage)
  dump('首启:', store)
  await tick(10)
  const n = store.getTasks().length
  console.log('  ==> 任务数:', n, n === 0 ? '✅ 旧数据没被读进来' : '❌ 竟然读到了旧数据')
  console.log('  ==> 旧 key:',
    'tm.tasks' in storage.data && 'tm.meta' in storage.data
      ? '✅ 原样保留，没读也没删' : '❌ 被改动了')
  console.log('  ==> 新 key:', 'tm.state' in storage.data ? '✅ 已建立 tm.state' : '❌ 没建立 tm.state')
}

Date.now = realNow
