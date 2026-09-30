/**
 * 复现用户的真实流程：不杀进程，只是切后台再回前台（index.onShow → store.reload()）。
 * 对比不同平台行为下的表现，验证修复。
 */
import { createStore } from './sim/store.js'
import { elapsedOf } from './sim/model.js'
import { formatHMS } from './sim/time.js'

let fakeNow = Date.now()
Date.now = () => fakeNow
const tick = (ms) => new Promise((r) => setTimeout(r, ms))
globalThis.__TOASTS__ = []

function makeStorage(opts = {}) {
  const data = {}
  return {
    data,
    get({ key, default: def, success, fail }) {
      setTimeout(() => {
        if (opts.readFails) return fail(null, 400)
        success(key in data ? data[key] : def)
      }, 0)
    },
    set({ key, value, success, fail }) {
      if (opts.writeFails) { setTimeout(() => fail(null, 500), 0); return }
      if (opts.silentDrop) {
        // 真机的坑：回调报成功，值根本没落盘
        setTimeout(() => success && success(), 0)
        return
      }
      data[key] = value
      setTimeout(() => success && success(), 0)
    },
    delete({ key, success }) { delete data[key]; setTimeout(success, 0) }
  }
}

async function boot(storage) {
  globalThis.__MOCK_STORAGE__ = storage
  globalThis.__TOASTS__ = []
  const store = createStore()
  await store.init()
  await tick(20)
  return store
}

const show = (label, store) => {
  const rows = store.buildRows(Date.now())
  const t = store.getTasks()[0]
  return label + ': ' + (rows.length === 0 ? '(空列表)' : rows.map((r) => `${r.title} ${r.elapsedText}`).join(' | ')) +
    '  磁盘=' + (Object.keys(globalThis.__MOCK_STORAGE__.data).join(',') || '(空)')
}

async function scenario(name, opts, prefixData) {
  console.log('\n===== ' + name + ' =====')
  const storage = makeStorage(opts)
  if (prefixData) Object.assign(storage.data, prefixData)

  // 打开软件
  let store = await boot(storage)
  if (prefixData) {
    const n = store.getTasks().length
    console.log('   启动时任务数=' + n + '（磁盘里有旧版本遗留 key）' + (n === 0 ? ' ✅ 已被忽略' : ' ❌ 竟被读进来了'))
  } else {
    console.log('   启动时任务数=' + store.getTasks().length)
  }

  // 加任务 → 开始 → 5 秒 → 暂停
  let r = store.getTasks()[0]
  if (!r) { r = store.addTask('看书', 3600000).task; await tick(20) }
  store.emitAction(r.id, 'start')
  await tick(20)
  fakeNow += 5000
  store.emitAction(r.id, 'pause')
  await tick(50)
  console.log('   ' + show('暂停后(内存)', store))

  // 上滑回表盘 → 再进应用：同一个 store 实例，走 reload()
  await store.reload()
  await tick(50)
  console.log('   ' + show('再进应用后', store))
  const t = store.getTasks()[0]
  const ok = t && elapsedOf(t, Date.now()) === 5000
  console.log('   ==> ' + (ok ? '✅ 时间保住了' : '❌ 时间归零'))
  console.log('   ==> toast: ' + globalThis.__TOASTS__.join(' / '))
}

const LEGACY = {
  'tm.tasks': JSON.stringify([{ id: 't_old', title: '看书', targetMs: 3600000, accumulatedMs: 0, runningSince: null,
    reachedAt: null, status: 'idle', order: 0, createdAt: 1, updatedAt: 1 }]),
  'tm.meta': JSON.stringify({ lastDate: '', schema: 1 })
}

await scenario('A 平台正常', {})
await scenario('B 平台正常 + 存储里有旧版本遗留 key（应被忽略）', {}, LEGACY)
await scenario('C 平台静默丢写（回调报成功但没落盘）', { silentDrop: true })
await scenario('D 静默丢写 + 有旧版本遗留 key', { silentDrop: true }, LEGACY)
