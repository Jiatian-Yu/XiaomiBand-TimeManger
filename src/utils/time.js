/** 时间格式化与日期比较（纯函数，无平台依赖） */

function pad2(n) {
  return n < 10 ? '0' + n : '' + n
}

/** 毫秒 → "HH:MM:SS"；超过 99 小时按实际位数展示，不截断 */
export function formatHMS(ms) {
  const total = Math.max(0, Math.floor((ms || 0) / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return pad2(h) + ':' + pad2(m) + ':' + pad2(s)
}

/** 时/分/秒 → 毫秒 */
export function parseHMS(h, m, s) {
  return ((h || 0) * 3600 + (m || 0) * 60 + (s || 0)) * 1000
}

/** 毫秒 → { h, m, s }，供时间选择器回显初值 */
export function splitHMS(ms) {
  const total = Math.max(0, Math.floor((ms || 0) / 1000))
  return {
    h: Math.floor(total / 3600),
    m: Math.floor((total % 3600) / 60),
    s: total % 60
  }
}

/**
 * 本地时区的 "YYYY-MM-DD"。
 * 千万不要用 toISOString()：那是 UTC，东八区会导致凌晨 8 点才跨天。
 */
export function todayStr() {
  const d = new Date()
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate()
}
