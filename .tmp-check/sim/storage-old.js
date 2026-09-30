/**
 * @system.storage 封装。
 * 只有本文件认识平台存储 API，替换实现时只改这里。
 *
 * ⚠️ 读取结果必须区分「读到了空」和「读失败了」：
 *   读失败时若把它当成空数据，调用方一 persist 就会把真实数据永久覆盖掉。
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
    storage.get({
      key: key,
      default: '',
      success: function (data) {
        const d = decode(data)
        resolve({ ok: !d.corrupt, value: d.value, corrupt: d.corrupt })
      },
      fail: function (data, code) {
        console.error('[storage] 读取失败', key, code)
        resolve({ ok: false, value: null, corrupt: false })
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
    storage.set({
      key: key,
      value: raw,
      success: function () {
        resolve(true)
      },
      fail: function (data, code) {
        console.error('[storage] 写入失败', key, code)
        resolve(false)
      }
    })
  })
}

export function removeItem(key) {
  return new Promise(function (resolve) {
    storage.delete({
      key: key,
      success: function () {
        resolve(true)
      },
      fail: function () {
        resolve(false)
      }
    })
  })
}
