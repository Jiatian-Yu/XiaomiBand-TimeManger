/**
 * 用旧版（14e557c^，双 key 并发写）的 store 跑同样的流程。
 * 假 storage 模拟真机行为：一次只处理一个写请求，并发的第二个被静默丢弃（不回任何回调）。
 */
import { createStore } from './sim/store-old.js'
import { elapsedOf } from './sim/model.js'
import { formatHMS } from './sim/time.js'

let fakeNow = Date.now()
Date.now = () => fakeNow
const tick = (ms) => new Promise((r) => setTimeout(r, ms))

function makeStorage(opts = {}) {
  const data = {}
  let inFlight = false
  return {
    data,
    get({ key, default: def, success }) {
      setTimeout(() => success(key in data ? data[key] : def), 0)
    },
    set({ key, value, success }) {
      if (opts.dropConcurrent && inFlight) {
        // 真机行为：同一 tick 的第二个 set 没写进去，但回调照样报成功
        setTimeout(() => success && success(), 0)
        return
      }
      inFlight = true
      data[key] = value
      setTimeout(() => {
        inFlight = false
        success && success()
      }, 0)
    },
    delete({ key, success }) { delete data[key]; setTimeout(success, 0) }
  }
}

async function boot(storage) {
  globalThis.__MOCK_STORAGE__ = storage
  const store = createStore()
  await store.init()
  await tick(10)
  return store
}

function show(label, store) {
  const rows = store.buildRows(Date.now())
  console.log('   ' + label,
    rows.length === 0 ? '(空列表)' : rows.map((r) => `${r.title} ${r.elapsedText} ${r.statusText}`).join(' | '),
    '| 存储:', Object.entries(globalThis.__MOCK_STORAGE__.data).map(([k, v]) => k + '=' + String(v).slice(0, 60)).join('  '))
}

async function scenario(name, opts) {
  console.log('\n===== ' + name + ' =====')
  const storage = makeStorage(opts)

  let store = await boot(storage)
  const r = store.addTask('看书', 3600000)
  await tick(10)
  store.emitAction(r.task.id, 'start')
  await tick(10)
  fakeNow += 60000                       // 坚持 1 分钟
  store.emitAction(r.task.id, 'pause')
  await tick(30)
  show('暂停后:', store)

  store = null                            // 退出软件
  await tick(50)

  const s2 = await boot(storage)          // 再打开
  show('重开后:', s2)
  const t = s2.getTasks()[0]
  const ms = t ? elapsedOf(t, Date.now()) : 0
  console.log('   ==> 坚持时间:', t ? formatHMS(ms) : '(任务都没了)', ms === 60000 ? '✅ 保住了' : '❌ 归零/丢失')

  // 再来一次冷启动，看是不是每次都归零
  await tick(50)
  const s3 = await boot(storage)
  const t3 = s3.getTasks()[0]
  console.log('   ==> 第二次重开:', t3 ? formatHMS(elapsedOf(t3, Date.now())) : '(无任务)')
}

await scenario('旧版 + 真机双 key 并发写（第二个被丢）', { dropConcurrent: true })
await scenario('旧版 + 存储完全正常', {})
