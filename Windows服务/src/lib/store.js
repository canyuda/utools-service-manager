// 渲染进程侧持久化：四层后端依次兜底，写=所有后端尽力写（各带写后验证），读=依次读谁有数据用谁
// 1) window.utools.dbStorage  2) window.utools.db 文档库  3) preload 桥(svcApi 转发)  4) localStorage
// 任一后端失败都会把具体错误带回给调用方展示
export const BUILD = 'ui-2026-09-24-c'

const KEYS = {
  wl: 'svc_whitelist',
  settings: 'svc_settings',
  audit: 'svc_audit'
}

function utools () {
  if (typeof window !== 'undefined' && window.utools) return window.utools
  try { if (typeof utools !== 'undefined') return utools } catch (e) { /* 未注入 */ }
  return undefined
}
function bridge () {
  return (typeof window !== 'undefined' && window.svcApi && window.svcApi.storageWrite) ? window.svcApi : null
}

/* ---- 后端 1：dbStorage 键值库 ---- */
function bStorage () {
  const x = utools()
  if (!x || !x.dbStorage) return null
  return {
    name: 'dbStorage',
    read (k) { const v = x.dbStorage.getItem(k); return v == null ? null : v },
    write (k, v) {
      x.dbStorage.setItem(k, v)
      const back = x.dbStorage.getItem(k)
      if (JSON.stringify(back) !== JSON.stringify(v)) throw new Error('写后读不一致')
    },
    del (k) { x.dbStorage.removeItem(k) }
  }
}

/* ---- 后端 2：utools.db 文档库（_rev 冲突自动重试） ---- */
function bDoc () {
  const x = utools()
  if (!x || !x.db) return null
  return {
    name: 'db',
    read (k) { const d = x.db.get(k); return d ? (d.data == null ? null : d.data) : null },
    write (k, v) {
      const doc = x.db.get(k)
      let r = doc ? x.db.put(Object.assign({}, doc, { data: v })) : x.db.put({ _id: k, data: v })
      if (!r.ok && /rev|conflict/i.test(String((r && r.error) || ''))) {
        const cur = x.db.get(k)
        if (cur) r = x.db.put(Object.assign({}, cur, { data: v }))
      }
      if (!r || !r.ok) throw new Error('db.put 失败: ' + ((r && r.error) || '未知'))
      const back = x.db.get(k)
      if (!back || JSON.stringify(back.data) !== JSON.stringify(v)) throw new Error('写后读不一致')
    },
    del (k) { const d = x.db.get(k); if (d) x.db.remove(d) }
  }
}

/* ---- 后端 3：preload 桥（svcApi.storageWrite/storageRead，走 preload 侧双后端） ---- */
function bBridge () {
  const a = bridge()
  if (!a) return null
  return {
    name: 'preload桥',
    read (k) { const v = a.storageRead(k); return v == null ? null : v },
    write (k, v) {
      const ok = a.storageWrite(k, v)
      if (!ok) throw new Error('桥写入返回 false（preload 侧双后端均失败，详见插件控制台 [svc] 日志）')
    }
  }
}

/* ---- 后端 4：localStorage（纯浏览器演示兜底） ---- */
function bLocal () {
  if (typeof localStorage === 'undefined') return null
  return {
    name: 'localStorage',
    read (k) { const v = localStorage.getItem('svcui_' + k); return v == null ? null : JSON.parse(v) },
    write (k, v) { localStorage.setItem('svcui_' + k, JSON.stringify(v)) },
    del (k) { localStorage.removeItem('svcui_' + k) }
  }
}

function backends () { return [bStorage(), bDoc(), bBridge(), bLocal()].filter(Boolean) }

function readKey (key, def) {
  for (const b of backends()) {
    try {
      const v = b.read(key)
      if (v != null) return v
    } catch (e) { console.error('[svc-ui] read(' + b.name + ') 失败：' + key, e) }
  }
  return def
}

function writeKey (key, val) {
  const errs = []
  let okAny = false
  for (const b of backends()) {
    try { b.write(key, val); okAny = true } catch (e) {
      errs.push(b.name + ': ' + e.message)
      console.error('[svc-ui] write(' + b.name + ') 失败：' + key, e)
    }
  }
  if (!okAny) console.error('[svc-ui] 所有后端写入失败：' + key + ' | ' + errs.join('；'))
  return { ok: okAny, errors: errs }
}

// 白名单必须包对象存储：uTools 的 dbStorage/db 不接受顶层数组（会被拒绝，写静默失败）
// 且写入前必须深拷贝成纯对象：调用方传入的可能是 Vue reactive Proxy，直接写会失败
function plain (v) { return JSON.parse(JSON.stringify(v)) }
export function getWhitelist () {
  const v = readKey(KEYS.wl, {})
  if (Array.isArray(v)) return v                       // 兼容历史裸数组格式
  return v && Array.isArray(v.list) ? v.list : []
}
export function saveWhitelist (list) {
  return writeKey(KEYS.wl, { list: plain(Array.isArray(list) ? list : []) })
}

export function getSettings () {
  return Object.assign({ mcpEnabled: false, mcpWriteEnabled: false }, readKey(KEYS.settings, {}))
}
export function saveSettings (patch) {
  const next = plain(Object.assign(getSettings(), patch || {}))
  const r = writeKey(KEYS.settings, next)
  return Object.assign(next, { _save: r })
}

export function getAudit () { return readKey(KEYS.audit, []) }
export function clearAudit () { return writeKey(KEYS.audit, []) }

// 存储自检：逐后端 写入→读回→比对→清理，返回每个后端的诊断
export function storageSelfTest () {
  const info = {}
  let okAny = false
  const bs = backends()
  if (!bs.length) info['-'] = '没有任何可用后端（utools/svcApi 均未注入）'
  for (const b of bs) {
    try {
      const t = Date.now()
      b.write('__svc_selftest__', t)
      const back = b.read('__svc_selftest__')
      b.del('__svc_selftest__')
      info[b.name] = back === t ? 'ok' : '读回不一致'
      if (back === t) okAny = true
    } catch (e) {
      info[b.name] = '失败: ' + e.message
    }
  }
  return { ok: okAny, error: okAny ? '' : '所有后端均失败', via: bs.map(b => b.name).join('/'), backends: info }
}
