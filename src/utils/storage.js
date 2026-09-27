/**
 * @system.storage 封装。
 * 只有本文件认识平台存储 API，替换实现时只改这里。
 * 平台的值类型是字符串，这里统一做 JSON 编解码 + 异常兜底。
 */
import storage from '@system.storage'

function decode(raw, fallback) {
  if (raw === null || raw === undefined || raw === '') return fallback
  try {
    const parsed = JSON.parse(raw)
    return parsed === null || parsed === undefined ? fallback : parsed
  } catch (e) {
    console.error('[storage] JSON 解析失败，已回退默认值:', e)
    return fallback
  }
}

export function getItem(key, fallback) {
  return new Promise(function (resolve) {
    storage.get({
      key: key,
      default: '',
      success: function (data) {
        resolve(decode(data, fallback))
      },
      fail: function (data, code) {
        console.error('[storage] 读取失败', key, code)
        resolve(fallback)
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
