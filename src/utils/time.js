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

/**
 * "YYYY-M-D" → 可比较的 YYYYMMDD 数字；解析不出来返回 null。
 * 用 Date(y, m-1, d) 构造再取日历字段，而不是 new Date(字符串)：
 * 后者对非补零格式的处理各引擎不一致，而且按毫秒差比较还会被夏令时
 * （23/25 小时的一天）和时区偏移坑到。取日历字段则天然安全。
 */
function dayNumber(s) {
  if (typeof s !== 'string') return null
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s)
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  if (isNaN(d.getTime())) return null
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate()
}

/**
 * a 是否比 b 早**至少一天**（两个参数都是 "YYYY-M-D" 本地日期串）。
 *
 * 这是跨天重置的唯一判据，所以对不可信输入一律返回 false：
 * 空串、格式不认识、以及 a 比 b 还晚（时钟被回拨 / 时区变了）都返回 false。
 * 语义是「宁可不重置，也不清掉用户累积的时间」。
 */
export function isEarlierDay(a, b) {
  const na = dayNumber(a)
  const nb = dayNumber(b)
  if (na === null || nb === null) return false
  return nb > na
}
