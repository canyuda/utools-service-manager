'use strict';
/* eslint-disable no-undef */
// uTools preload：Windows 服务控制层 + MCP 工具注册
// 运行在 CommonJS 预加载环境（public/preload/package.json 指定 type=commonjs），
// 向渲染进程暴露 window.svcApi；插件初始化时通过 utools.registerTool 注册 MCP 工具。
const { execFile } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const P = require('./svc-parse.js')

/* ---------------- 临时诊断日志（排障用，后续版本移除） ---------------- */
const LOG_FILE = path.join(process.env.TEMP || process.env.TMP || '.', 'svc-plugin-debug.log')
function appendLog (line) {
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 200 * 1024) fs.writeFileSync(LOG_FILE, '')
    fs.appendFileSync(LOG_FILE, new Date().toISOString() + ' ' + line + '\n')
  } catch (e) { /* ignore */ }
}

// uTools API 桥可能晚于 preload 顶层执行才注入 window，必须每次惰性获取，不能顶层缓存
function utoolsApi () {
  if (typeof window !== 'undefined' && window.utools) return window.utools
  try { return utools } catch (e) { return undefined }
}
function utoolsVia () {
  if (typeof window !== 'undefined' && window.utools) return 'window.utools'
  try { if (typeof utools !== 'undefined') return 'global utools' } catch (e) { /* 未注入 */ }
  return '未注入'
}

/* ---------------- 进程执行 ---------------- */
const RUN_TIMEOUT = 15000
const PS_TIMEOUT = 20000

function run (cmd, args, timeout = RUN_TIMEOUT) {
  return new Promise((resolve) => {
    execFile(cmd, args, {
      encoding: 'utf8',
      timeout,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024
    }, (err, stdout, stderr) => {
      if (err && typeof err.code !== 'number') {
        return resolve({ code: -1, stdout: '', stderr: String((err && err.message) || err) })
      }
      resolve({ code: err ? err.code : 0, stdout: stdout || '', stderr: stderr || '' })
    })
  })
}

function runPs (script, timeout = PS_TIMEOUT) {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], timeout)
}

function parseJsonOut (stdout) {
  try {
    const v = JSON.parse(stdout)
    return v
  } catch (e) {
    return []
  }
}

/* ---------------- 错误码映射（设计文档 §7.2） ---------------- */
const ERR_TEXT = {
  0: '成功',
  5: '权限不足：请先在插件中完成该服务的「管理授权」（UAC 确认）；系统保护服务授权后也可能拒绝',
  1051: '该服务正被其他运行中的服务依赖，无法停止',
  1052: '该服务不接受暂停/恢复操作',
  1053: '服务未及时响应启动或停止请求',
  1056: '服务已在运行中',
  1060: '服务不存在，可能已被卸载',
  1062: '服务当前未启动',
  1072: '服务已被标记为删除'
}
function textOfCode (code, fallback) {
  return ERR_TEXT[code] || fallback || ('错误码 ' + code)
}
const START_TYPE_TEXT = { auto: '自动', 'delayed-auto': '自动(延迟启动)', demand: '手动', disabled: '禁用' }
const START_TYPES = ['auto', 'delayed-auto', 'demand', 'disabled']

/* ---------------- 服务查询（PowerShell 单进程批量） ---------------- */
function psNameLit (n) { return String(n).replace(/'/g, "''") }

// startMode(Auto/Manual/Disabled) + 注册表 DelayedAutostart → auto/delayed-auto/demand/disabled
function mapStartType (startMode, delayed) {
  if (startMode === 'Auto') return delayed ? 'delayed-auto' : 'auto'
  if (startMode === 'Disabled') return 'disabled'
  return 'demand'
}

function normalizeSvc (s) {
  if (!s) return null
  if (s.exists === false) return { exists: false, name: s.name }
  return {
    exists: true,
    name: s.name,
    displayName: s.displayName,
    state: s.state,
    startType: mapStartType(s.startMode, !!s.delayed),
    acceptPause: !!s.acceptPause,
    acceptStop: !!s.acceptStop,
    account: s.account,
    binPath: s.binPath,
    description: s.description,
    processId: s.processId
  }
}

// 按服务名批量查询（含延迟启动标志），单次 PowerShell 进程完成
async function getServicesStatus (names) {
  const lit = JSON.stringify((names || []).map(String)).replace(/'/g, "''")
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$names = @('${lit}') | ConvertFrom-Json
$out = foreach ($n in $names) {
  $nn = [string]$n -replace "'", "''"
  $s = Get-CimInstance Win32_Service -Filter "Name='$nn'" | Select-Object -First 1
  if ($s) {
    $delayed = $false
    $rp = Get-ItemProperty -Path ("HKLM:\\SYSTEM\\CurrentControlSet\\Services\\" + $s.Name) -ErrorAction SilentlyContinue
    if ($rp -and $rp.DelayedAutostart -eq 1) { $delayed = $true }
    [PSCustomObject]@{ exists=$true; name=$s.Name; displayName=$s.DisplayName; state=[string]$s.State; startMode=[string]$s.StartMode; delayed=$delayed; acceptPause=($s.AcceptPause -eq $true); acceptStop=($s.AcceptStop -eq $true); account=$s.StartName; binPath=$s.PathName; description=$s.Description; processId=$s.ProcessId }
  } else {
    [PSCustomObject]@{ exists=$false; name=[string]$n }
  }
}
ConvertTo-Json -InputObject @($out) -Compress
`
  const { stdout } = await runPs(script)
  const rows = parseJsonOut(stdout)
  return (Array.isArray(rows) ? rows : [rows]).map(normalizeSvc).filter(Boolean)
}

// 全量服务列表（添加页用；不读注册表，保证速度）
async function listAllServices () {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$out = Get-CimInstance Win32_Service | ForEach-Object {
  [PSCustomObject]@{ exists=$true; name=$_.Name; displayName=$_.DisplayName; state=[string]$_.State; startMode=[string]$_.StartMode; acceptPause=($_.AcceptPause -eq $true) }
}
ConvertTo-Json -InputObject @($out) -Compress
`
  const { stdout } = await runPs(script, 30000)
  const rows = parseJsonOut(stdout)
  return (Array.isArray(rows) ? rows : [rows]).map(normalizeSvc).filter(x => x && x.exists)
}

/* ---------------- 状态轮询（sc.exe 轻量热路径） ---------------- */
// 2 秒热路径不用 PowerShell：一次 `sc query state= all` 覆盖全量服务状态（单进程、开销约几十 ms），
// 按白名单过滤返回；启动类型/显示名等完整信息仍走 getServicesStatus（用户触发的冷路径）。
async function pollStatuses (names) {
  const want = new Set((names || []).map(String))
  if (!want.size) return []
  const { stdout } = await run('sc.exe', ['query', 'state=', 'all'])
  return P.parseScQueryAll(stdout).filter(r => want.has(r.name))
}

// 单服务轻量状态查询（重启等待循环 / MCP 返回状态用，替代原来每 800ms 拉一次 PowerShell）
async function quickState (name) {
  const { stdout } = await run('sc.exe', ['query', name])
  return P.parseScQueryOne(stdout)
}

/* ---------------- 服务控制（sc.exe） ---------------- */
// sc config 语法要求 "start= auto"（= 后必须有空格），argv 数组拼出的命令行恰好是该形式
async function control (name, action) {
  if (!['start', 'stop', 'pause', 'continue'].includes(action)) {
    return { ok: false, errorCode: 'INVALID_ACTION', message: '不支持的操作：' + action }
  }
  const { code } = await run('sc.exe', [action, name])
  if (code === 0) return { ok: true }
  // 不回传 sc 原始输出（GBK 会被 utf8 解码成乱码），未知错误码直接展示码值
  return { ok: false, errorCode: code, message: textOfCode(code) }
}

async function setStartType (name, startType) {
  if (!START_TYPES.includes(startType)) {
    return { ok: false, errorCode: 'INVALID_STARTTYPE', message: '无效的启动类型：' + startType }
  }
  const { code } = await run('sc.exe', ['config', name, 'start=', startType])
  if (code === 0) return { ok: true }
  return { ok: false, errorCode: code, message: textOfCode(code) }
}

async function restartService (name) {
  const stop = await control(name, 'stop')
  if (!stop.ok && stop.errorCode !== 1062) return stop // 未启动的服务直接当 stopped 处理
  const t0 = Date.now()
  for (;;) {
    await new Promise(r => setTimeout(r, 800))
    const st = await quickState(name)
    if (!st || st.state === 'Stopped') break
    if (Date.now() - t0 > 15000) {
      return { ok: false, errorCode: 1053, message: ERR_TEXT[1053] + '（等待停止超时）' }
    }
  }
  return control(name, 'start')
}

async function isAdmin () {
  return (await run('net', ['session'], 8000)).code === 0
}

/* ---------------- 按服务授权（SDDL 追加当前用户 ACE，UAC 提权执行） ---------------- */
// 插件本体不要求管理员：授权后的服务，普通身份即可启动/停止/暂停/改启动类型（含 MCP 写操作）。
// 原安全描述符备份在 K.auth，撤销时经 UAC 还原为授权时刻的原串。
// 用绝对路径：避免类 Unix 环境（Git Bash 等）里 coreutils 的 whoami 抢占 PATH
const WHOAMI_EXE = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'whoami.exe')
let sidCache = null
async function getUserSid () {
  if (sidCache) return sidCache
  const { stdout } = await run(WHOAMI_EXE, ['/user', '/fo', 'csv', '/nh'])
  sidCache = P.parseWhoamiSid(stdout)
  return sidCache
}

// 批量检查授权状态 → { [name]: bool }。管理员全真；否则逐个 sdshow 看当前用户是否拥有 RP+WP+DC
async function checkAuth (names) {
  const list = [...new Set((names || []).map(String))].filter(Boolean)
  const out = {}
  if (!list.length) return out
  if (await isAdmin()) {
    for (const n of list) out[n] = true
    return out
  }
  const sid = await getUserSid()
  if (!sid) {
    // 拿不到 SID 时不拦界面；真正执行写操作失败（error 5）时由界面兜底纠正
    for (const n of list) out[n] = true
    return out
  }
  await Promise.all(list.map(async (n) => {
    const { code, stdout } = await run('sc.exe', ['sdshow', n])
    const sddl = code === 0 ? P.extractSddl(stdout) : null
    out[n] = !!sddl && P.sddlHasRights(sddl, sid, ['RP', 'WP', 'DC'])
  }))
  return out
}

function tempPath (ext) {
  return path.join(os.tmpdir(), 'svc-auth-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.' + ext)
}

// 写任务文件 → UAC 拉起提权 PS 执行 AUTH_PS1 → 读回结果文件。
// exit 1252 = UAC 被取消/提权失败；结果文件缺失同义。
async function runElevatedAuth (job) {
  const jobPath = tempPath('job.json')
  const resultPath = tempPath('result.json')
  const scriptPath = tempPath('auth.ps1')
  fs.writeFileSync(jobPath, JSON.stringify(job), 'utf8')
  // BOM 让 Windows PowerShell 5 按 UTF-8 读取（脚本含中文报错文案）
  fs.writeFileSync(scriptPath, '\ufeff' + P.AUTH_PS1, 'utf8')
  const q = (s) => String(s).replace(/'/g, "''")
  const launcher = "$ErrorActionPreference='Stop'; try { $p = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','" + q(scriptPath) + "','-JobPath','" + q(jobPath) + "','-ResultPath','" + q(resultPath) + "'; exit $p.ExitCode } catch { exit 1252 }"
  try {
    const { code } = await runPs(launcher, 120000)
    let res = null
    try { res = JSON.parse(fs.readFileSync(resultPath, 'utf8').replace(/^\uFEFF/, '')) } catch (e) { /* 无结果文件 = UAC 未确认或脚本未执行 */ }
    if (!res) {
      return code === 1252
        ? { ok: false, cancelled: true, message: '已取消：未在 UAC 窗口中确认授权' }
        : { ok: false, message: '授权未完成：UAC 提权失败（错误码 ' + code + '）' }
    }
    return res
  } finally {
    for (const f of [jobPath, resultPath, scriptPath]) { try { fs.unlinkSync(f) } catch (e) { /* ignore */ } }
  }
}

async function grantAuth (names) {
  const list = [...new Set((names || []).map(String))].filter(Boolean)
  if (!list.length) return { ok: true, results: [] }
  const sid = await getUserSid()
  if (!sid) return { ok: false, message: '无法获取当前用户 SID，无法授权' }
  const res = await runElevatedAuth({ services: list, sid })
  const backups = dbGet(K.auth, {})
  let changed = false
  for (const x of ((res && res.results) || [])) {
    if (x.ok && x.before) { backups[x.name] = x.before; changed = true }
  }
  if (changed) dbSet(K.auth, backups)
  return res
}

// 串行化撤销：内部是「读全部备份 → 删本次的 → 整体写回」，并发调用会拿同一份旧快照
// 互相覆盖（后完成者把先完成者已删的备份写回去），必须排队执行
let revokeSeq = Promise.resolve()
function revokeAuth (names) {
  const run = revokeSeq.then(() => doRevokeAuth(names))
  revokeSeq = run.then(() => {}, () => {})
  return run
}
async function doRevokeAuth (names) {
  const list = [...new Set((names || []).map(String))].filter(Boolean)
  const backups = dbGet(K.auth, {})
  const have = {}
  const missing = []
  for (const n of list) {
    if (backups[n]) have[n] = backups[n]
    else missing.push(n)
  }
  const results = missing.map(n => ({ name: n, ok: false, error: '未找到授权备份，无法安全撤销' }))
  if (Object.keys(have).length) {
    // services 必须传：AUTH_PS1 的 foreach 以 @($job.services) 迭代，缺省会以 $null
    // 迭代一次并在 $backups.PSObject.Properties[$null] 上抛「索引操作失败」
    const r = await runElevatedAuth({ revoke: true, services: Object.keys(have), backups: have })
    results.push(...((r && r.results) || []))
    if (r && r.ok) {
      for (const n of Object.keys(have)) delete backups[n]
      dbSet(K.auth, backups)
    } else {
      return { ok: false, results }
    }
  }
  return { ok: missing.length === 0, results }
}

function getAuthBackups () { return dbGet(K.auth, {}) }

/* ---------------- 持久化（utools.dbStorage） ---------------- */
const K = { wl: 'svc_whitelist', settings: 'svc_settings', audit: 'svc_audit', auth: 'svc_auth_backup' }
const DEFAULT_SETTINGS = { mcpEnabled: false, mcpWriteEnabled: false }

/* ---- 持久化双后端（与渲染进程 store.js 同策略）：dbStorage + utools.db 文档库 ---- */
function bStorageApi (u) {
  if (!u || !u.dbStorage) return null
  return {
    read (k) { const v = u.dbStorage.getItem(k); return v == null ? null : v },
    write (k, v) {
      u.dbStorage.setItem(k, v)
      const back = u.dbStorage.getItem(k)
      if (JSON.stringify(back) !== JSON.stringify(v)) throw new Error('写后读不一致')
    }
  }
}
function bDocApi (u) {
  if (!u || !u.db) return null
  return {
    read (k) { const d = u.db.get(k); return d ? (d.data == null ? null : d.data) : null },
    write (k, v) {
      const doc = u.db.get(k)
      let r = doc ? u.db.put(Object.assign({}, doc, { data: v })) : u.db.put({ _id: k, data: v })
      if (!r.ok && /rev|conflict/i.test(String((r && r.error) || ''))) {
        const cur = u.db.get(k)
        if (cur) r = u.db.put(Object.assign({}, cur, { data: v }))
      }
      if (!r || !r.ok) throw new Error('db.put 失败: ' + ((r && r.error) || '未知'))
    }
  }
}
function dbBackends () { const u = utoolsApi(); return [bStorageApi(u), bDocApi(u)].filter(Boolean) }

function dbGet (key, def) {
  for (const b of dbBackends()) {
    try { const v = b.read(key); if (v != null) return v } catch (e) { console.error('[svc] read(' + b.name + ') 失败：' + key, e) }
  }
  return def
}
function dbSet (key, val) {
  let okAny = false
  const errs = []
  for (const b of dbBackends()) {
    try { b.write(key, val); okAny = true } catch (e) {
      errs.push(b.name + ': ' + e.message)
      console.error('[svc] write(' + b.name + ') 失败：' + key, e)
    }
  }
  if (!okAny) console.error('[svc] 所有后端写入失败：' + key + ' | ' + errs.join(' | '))
  return okAny
}

function getWhitelist () {
  const v = dbGet(K.wl, {})
  const out = Array.isArray(v) ? v : (v && Array.isArray(v.list) ? v.list : [])
  appendLog('getWhitelist raw=' + JSON.stringify(v) + ' -> ' + out.length + ' 项')
  return out
}
function saveWhitelist (list) {
  const wrapped = { list: Array.isArray(list) ? list : [] }
  const ok = dbSet(K.wl, wrapped)
  appendLog('saveWhitelist ok=' + ok + ' ' + JSON.stringify(wrapped))
  return ok
}

function getSettings () { return Object.assign({}, DEFAULT_SETTINGS, dbGet(K.settings, {})) }
function saveSettings (patch) {
  const next = Object.assign(getSettings(), patch || {})
  dbSet(K.settings, next)
  return next
}

function getAudit () { return dbGet(K.audit, []) }
function pushAudit (tool, input, result) {
  const list = getAudit()
  list.unshift({ ts: Date.now(), tool, input: input || {}, ok: !!(result && result.ok), message: (result && result.message) || '' })
  dbSet(K.audit, list.slice(0, 50))
}
function clearAudit () { dbSet(K.audit, []) }

/* ---------------- MCP 工具（plugin.json tools 键必须一一对应） ---------------- */
function guard (write) {
  const st = getSettings()
  if (!st.mcpEnabled) return { ok: false, errorCode: 'MCP_DISABLED', message: 'Agent 控制未开启：请在 uTools 插件「Windows 服务管理」设置中开启 MCP 总开关' }
  if (write && !st.mcpWriteEnabled) return { ok: false, errorCode: 'MCP_WRITE_DISABLED', message: 'Agent 写操作未开启：请在插件设置中允许 Agent 写操作' }
  return null
}

async function stateAfterOk (name, r) {
  if (!r.ok) return r
  const st = await quickState(name)
  return Object.assign(r, { service: name, state: st ? st.state : undefined })
}

let mcpRegistered = false
function registerMcpTools () {
  if (mcpRegistered) return
  const u = utoolsApi()
  if (!u || typeof u.registerTool !== 'function') return false
  mcpRegistered = true
  const wrap = (tool, write, fn) => {
    u.registerTool(tool, async (params) => {
      let result
      try {
        const g = guard(write)
        result = g || await fn(params || {})
      } catch (e) {
        result = { ok: false, errorCode: 'ERROR', message: String((e && e.message) || e) }
      }
      pushAudit(tool, params, result)
      return result
    })
  }

  wrap('list_managed_services', false, async () => {
    const wl = getWhitelist()
    const services = await getServicesStatus(wl.map(x => x.name))
    return { ok: true, count: services.length, services }
  })

  wrap('search_services', false, async (p) => {
    const all = await listAllServices()
    const q = String((p && p.query) || '').trim().toLowerCase()
    const services = q ? all.filter(s => ((s.name + ' ' + s.displayName).toLowerCase().includes(q))) : all
    return { ok: true, count: services.length, services }
  })

  wrap('get_service_detail', false, async (p) => {
    const rows = await getServicesStatus([String((p && p.name) || '')])
    const s = rows[0]
    if (!s || !s.exists) return { ok: false, errorCode: 1060, message: ERR_TEXT[1060] }
    return { ok: true, service: s }
  })

  wrap('start_service', true, async (p) => stateAfterOk(psName(p), await control(psName(p), 'start')))
  wrap('stop_service', true, async (p) => stateAfterOk(psName(p), await control(psName(p), 'stop')))
  wrap('pause_service', true, async (p) => stateAfterOk(psName(p), await control(psName(p), 'pause')))
  wrap('resume_service', true, async (p) => stateAfterOk(psName(p), await control(psName(p), 'continue')))
  wrap('restart_service', true, async (p) => stateAfterOk(psName(p), await restartService(psName(p))))

  wrap('set_service_start_type', true, async (p) => {
    const name = psName(p)
    const t = p && p.startType
    const r = await setStartType(name, t)
    return Object.assign(r, r.ok ? { service: name, startType: t } : { service: name })
  })

  wrap('storage_debug', false, async () => {
    return { ok: true, dump: storageDump() }
  })
}
function psName (p) { return String((p && p.name) || '') }

// 桥注入时机会晚于 preload 顶层执行：拿不到 registerTool 就延迟重试（最多 20×250ms）
function registerMcpToolsWithRetry (attempt) {
  const r = registerMcpTools()
  if (r === false && attempt < 20) {
    appendLog('registerTool 重试 ' + (attempt + 1) + ' via=' + utoolsVia())
    setTimeout(() => registerMcpToolsWithRetry(attempt + 1), 250)
  } else if (r !== false) {
    appendLog('registerTool 成功')
  } else {
    appendLog('registerTool 最终失败：桥始终未注入')
  }
}
// 诊断：preload 环境下两个后端中所有键的原始内容
function storageDump () {
  const u = utoolsApi()
  const out = {
    via: u ? (typeof window !== 'undefined' && window.utools ? 'window.utools' : 'global utools') : '未注入',
    hasDbStorage: !!(u && u.dbStorage),
    hasDb: !!(u && u.db),
    kv: {},
    docs: {}
  }
  const keys = Object.values(K)
  if (u && u.dbStorage) {
    for (const k of keys) { try { out.kv[k] = u.dbStorage.getItem(k) } catch (e) { out.kv[k] = 'ERR: ' + e.message } }
  }
  if (u && u.db) {
    for (const k of keys) { try { const d = u.db.get(k); out.docs[k] = d ? d.data : null } catch (e) { out.docs[k] = 'ERR: ' + e.message } }
  }
  return out
}

appendLog('preload 加载 build=preload-2026-09-29-a via=' + utoolsVia() +
  ' hasDbStorage=' + !!(utoolsApi() && utoolsApi().dbStorage) +
  ' hasDb=' + !!(utoolsApi() && utoolsApi().db))
registerMcpToolsWithRetry(0)

/* ---------------- 向渲染进程暴露接口 ---------------- */
window.svcApi = {
  BUILD: 'preload-2026-09-29-a',
  debugLog: (line) => appendLog('[ui] ' + line),
  storageRead: (key) => dbGet(key, null),
  storageWrite: (key, val) => dbSet(key, val),
  getServicesStatus,
  pollStatuses,
  listAllServices,
  control,
  setStartType,
  restartService,
  isAdmin,
  checkAuth,
  grantAuth,
  revokeAuth,
  getAuthBackups,
  getWhitelist,
  saveWhitelist,
  getSettings,
  saveSettings,
  getAudit,
  clearAudit,
  storageDump,
  START_TYPE_TEXT,
  START_TYPES,
  ERR_TEXT
}
