// 后端选择：uTools 环境用 preload 注入的 window.svcApi；浏览器 npm run dev 时降级为演示数据
const real = typeof window !== 'undefined' ? window.svcApi : null
export const isDemo = !real

export const START_TYPE_TEXT = (real && real.START_TYPE_TEXT) || { auto: '自动', 'delayed-auto': '自动(延迟启动)', demand: '手动', disabled: '禁用' }
export const START_TYPES = (real && real.START_TYPES) || ['auto', 'delayed-auto', 'demand', 'disabled']

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function demoBackend () {
  const KEY = (k) => 'svc_demo_' + k
  const base = [
    { exists: true, name: 'Redis', displayName: 'Redis', state: 'Running', startType: 'auto', acceptPause: false, acceptStop: true, account: 'NetworkService', binPath: 'C:\\Redis\\redis-server.exe --service-run', description: 'Redis 内存数据库服务（内置 --service-run）' },
    { exists: true, name: 'Consul', displayName: 'Consul', state: 'Running', startType: 'auto', acceptPause: false, acceptStop: true, account: 'LocalSystem', binPath: 'D:\\5-zujian\\nssm.exe', description: 'Consul Agent（NSSM 包装）' },
    { exists: true, name: 'nginx', displayName: 'nginx', state: 'Running', startType: 'auto', acceptPause: false, acceptStop: true, account: 'LocalSystem', binPath: 'D:\\5-zujian\\nssm.exe', description: 'nginx web server（NSSM 包装）' },
    { exists: true, name: 'Spooler', displayName: 'Print Spooler', state: 'Stopped', startType: 'demand', acceptPause: true, acceptStop: true, account: 'LocalSystem', binPath: 'C:\\WINDOWS\\system32\\spoolsv.exe', description: '将文件加载到内存中以便稍后打印' },
    { exists: true, name: 'Fax', displayName: 'Fax', state: 'Paused', startType: 'demand', acceptPause: true, acceptStop: true, account: 'NetworkService', binPath: 'C:\\WINDOWS\\system32\\fxssvc.exe', description: '发送和接收传真' }
  ]
  const clone = () => JSON.parse(JSON.stringify(base))
  const db = {
    get (k, d) { try { const v = localStorage.getItem(KEY(k)); return v == null ? d : JSON.parse(v) } catch (e) { return d } },
    set (k, v) { try { localStorage.setItem(KEY(k), JSON.stringify(v)) } catch (e) { /* ignore */ } }
  }

  return {
    async getStatuses (names) {
      await sleep(120)
      const cur = db.get('svcs', null) || clone()
      return names.map(n => cur.find(s => s.name === n) || { exists: false, name: n })
    },
    async listAll () {
      await sleep(300)
      return db.get('svcs', null) || clone()
    },
    async control (name, action) {
      await sleep(400)
      const cur = db.get('svcs', null) || clone()
      const s = cur.find(x => x.name === name)
      if (!s) return { ok: false, errorCode: 1060, message: '服务不存在，可能已被卸载' }
      const m = { start: 'Running', stop: 'Stopped', pause: 'Paused', continue: 'Running' }
      s.state = m[action]
      db.set('svcs', cur)
      return { ok: true }
    },
    async setStartType (name, t) {
      await sleep(400)
      const cur = db.get('svcs', null) || clone()
      const s = cur.find(x => x.name === name)
      if (!s) return { ok: false, errorCode: 1060, message: '服务不存在，可能已被卸载' }
      s.startType = t
      db.set('svcs', cur)
      return { ok: true }
    },
    async restart (name) {
      const r1 = await this.control(name, 'stop')
      if (!r1.ok) return r1
      await sleep(900)
      return this.control(name, 'start')
    },
    async isAdmin () { await sleep(50); return false },
    // 演示模式：Redis 默认已授权，其余未授权，便于预览授权流程
    async pollStatuses (names) { return this.getStatuses(names) },
    async checkAuth (names) {
      await sleep(50)
      const granted = db.get('granted', ['Redis'])
      const out = {}
      names.forEach(n => { out[n] = granted.includes(n) })
      return out
    },
    async grantAuth (names) {
      await sleep(600)
      const granted = db.get('granted', ['Redis'])
      names.forEach(n => { if (!granted.includes(n)) granted.push(n) })
      db.set('granted', granted)
      return { ok: true, results: names.map(n => ({ name: n, ok: true })) }
    },
    async revokeAuth (names) {
      await sleep(300)
      const granted = db.get('granted', ['Redis'])
      db.set('granted', granted.filter(n => !names.includes(n)))
      return { ok: true, results: names.map(n => ({ name: n, ok: true })) }
    },
    async getAuthBackups () {
      return Object.fromEntries(db.get('granted', ['Redis']).map(n => [n, 'DEMO']))
    },
    async getWhitelist () { return db.get('wl', [{ name: 'Redis', displayName: 'Redis' }, { name: 'Consul', displayName: 'Consul' }, { name: 'nginx', displayName: 'nginx' }]) },
    async saveWhitelist (list) { db.set('wl', list) },
    async getSettings () { return Object.assign({ mcpEnabled: false, mcpWriteEnabled: false }, db.get('settings', {})) },
    async saveSettings (patch) {
      const next = Object.assign(await this.getSettings(), patch || {})
      db.set('settings', next)
      return next
    },
    async getAudit () { return db.get('audit', []) },
    async clearAudit () { db.set('audit', []) }
  }
}

// 统一方法名：preload 注入的真实接口与 demo 后端在这里对齐成同一套签名
function wrapReal (api) {
  return {
    getStatuses: (names) => api.getServicesStatus(names),
    pollStatuses: (names) => api.pollStatuses(names),
    listAll: () => api.listAllServices(),
    control: (name, action) => api.control(name, action),
    setStartType: (name, t) => api.setStartType(name, t),
    restart: (name) => api.restartService(name),
    isAdmin: () => api.isAdmin(),
    checkAuth: (names) => api.checkAuth(names),
    grantAuth: (names) => api.grantAuth(names),
    revokeAuth: (names) => api.revokeAuth(names),
    getAuthBackups: () => api.getAuthBackups(),
    getWhitelist: () => api.getWhitelist(),
    saveWhitelist: (list) => api.saveWhitelist(list),
    getSettings: () => api.getSettings(),
    saveSettings: (patch) => api.saveSettings(patch),
    getAudit: () => api.getAudit(),
    clearAudit: () => api.clearAudit()
  }
}

export const svc = real ? wrapReal(real) : demoBackend()
