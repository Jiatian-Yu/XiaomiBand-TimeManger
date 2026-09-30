/**
 * @system.storage 封装。
 * 只有本文件认识平台存储 API，替换实现时只改这里。
 *
 * ⚠️ 读取结果必须区分「读到了空」和「读失败了」：
 *   读失败时若把它当成空数据，调用方一 persist 就会把真实数据永久覆盖掉。
 *
 * ⚠️ success / fail 说的是「结果是什么」，complete 说的是「这次调用结束了」。
 *   三个回调都要接：只认前两个的话，平台一旦走了一条两个都不调的路径，
 *   Promise 就永远 pending，调用方的串行写锁（store.js 的 writing）会永久卡死，
 *   之后所有写盘静默失效（harness 的 S2 场景）。所以 complete 里要检查
 *   「结束了但还没有结论」这种情况，一律按失败处理，交给上层重试。
 */
const storage = new Proxy({}, { get: (_, p) => globalThis.__MOCK_STORAGE__[p] })

/**
 * @returns {{ value: any, corrupt: boolean }}
 * corrupt = 存储里确实有值，但 JSON 解析不了
 */
function decode(raw) {
  if (raw === null || raw === undefined || raw === '') {
    return { value: null, corrupt: false }
  }
  try {
    return { value: JSON.parse(raw), corrupt: false }
  } catch (e) {
    console.error('[storage] JSON 解析失败，按损坏处理:', e)
    return { value: null, corrupt: true }
  }
}

/**
 * 读取。
 * @returns {Promise<{ok: boolean, value: any, corrupt: boolean}>}
 *   ok=false 表示这次读取本身失败了，**调用方不要用它的值去覆盖现有数据**
 */
export function getItem(key) {
  return new Promise(function (resolve) {
    // 三个回调都可能被调（complete 在 success/fail 之后），保证只 resolve 一次
    let settled = false
    function settle(ok, value, corrupt) {
      if (settled) return false
      settled = true
      resolve({ ok: ok, value: value, corrupt: corrupt })
      return true
    }
    storage.get({
      key: key,
      default: '',
      success: function (data) {
        const d = decode(data)
        settle(!d.corrupt, d.value, d.corrupt)
      },
      fail: function (data, code) {
        console.error('[storage] 读取失败', key, code)
        settle(false, null, false)
      },
      // 调用结束了却还没有结论 = 不能当成「读到了空」，按读取失败处理
      complete: function () {
        if (settle(false, null, false)) {
          console.error('[storage] 读取只收到 complete，没有 success/fail，按失败处理', key)
        }
      }
    })
  })
}

export function setItem(key, value) {
  return new Promise(function (resolve) {
    let raw
    try {
      raw = JSON.stringify(value)
    } catch (e) {
      console.error('[storage] 序列化失败', key, e)
      resolve(false)
      return
    }
    let settled = false
    function settle(ok) {
      if (settled) return false
      settled = true
      resolve(ok)
      return true
    }
    storage.set({
      key: key,
      value: raw,
      success: function () {
        settle(true)
      },
      fail: function (data, code) {
        console.error('[storage] 写入失败', key, code)
        settle(false)
      },
      // 调用结束了却还没有结论 = 这次写的结果未知。按失败处理：
      // 重写一份相同的快照是幂等的，但当成成功会让数据静默丢失。
      complete: function () {
        if (settle(false)) {
          console.error('[storage] 写入只收到 complete，没有 success/fail，按失败处理', key)
        }
      }
    })
  })
}

export function removeItem(key) {
  return new Promise(function (resolve) {
    let settled = false
    function settle(ok) {
      if (settled) return false
      settled = true
      resolve(ok)
      return true
    }
    storage.delete({
      key: key,
      success: function () {
        settle(true)
      },
      fail: function (data, code) {
        console.error('[storage] 删除失败', key, code)
        settle(false)
      },
      complete: function () {
        if (settle(false)) {
          console.error('[storage] 删除只收到 complete，没有 success/fail，按失败处理', key)
        }
      }
    })
  })
}
