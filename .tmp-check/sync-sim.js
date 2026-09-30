/**
 * 把 src/utils 下的源码同步到 sim/，并把平台模块换成 mock。
 * 改完代码先跑这个，再跑 harness2.mjs。
 */
const fs = require('fs')
const path = require('path')

const SRC = path.join(__dirname, '..', 'src', 'utils')
const SIM = path.join(__dirname, 'sim')

for (const f of ['store.js', 'storage.js', 'model.js', 'time.js']) {
  let s = fs.readFileSync(path.join(SRC, f), 'utf8')
  // 相对导入补上扩展名（Node ESM 要求）
  s = s.replace(/from '(\.\/[a-z]+)'/g, "from '$1.js'")
  // 平台模块 → mock
  s = s.replace(
    /import storage from '@system\.storage'/,
    'const storage = new Proxy({}, { get: (_, p) => globalThis.__MOCK_STORAGE__[p] })'
  )
  s = s.replace(
    /import prompt from '@system\.prompt'/,
    'const prompt = { showToast: function (o) { globalThis.__TOASTS__.push(o.message) } }'
  )
  fs.writeFileSync(path.join(SIM, f), s)
}
console.log('sim 已同步')
