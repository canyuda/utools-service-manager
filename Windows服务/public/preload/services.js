'use strict';
/* eslint-disable no-undef */
// uTools preload：Windows 服务控制层 + MCP 工具注册
// 运行在 CommonJS 预加载环境（public/preload/package.json 指定 type=commonjs），
// 向渲染进程暴露 window.svcApi；插件初始化时通过 utools.registerTool 注册 MCP 工具。
const { execFile } = require('child_process')
const fs = require('fs')
const fsp = fs.promises
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
const ELEVATED_TIMEOUT = 60000

function run (cmd, args, timeout = RUN_TIMEOUT, onSpawn) {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, {
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
    if (onSpawn) onSpawn(child) // 供等待 UAC 期间从外部 kill
  })
}

function runPs (script, timeout = PS_TIMEOUT, onSpawn) {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], timeout, onSpawn)
}

// 以 Buffer 取原始输出（控制台程序管道输出是系统码页字节，utf8 解码会毁掉中文显示名）
function runBuf (cmd, args, timeout = RUN_TIMEOUT) {
  return new Promise((resolve) => {
    execFile(cmd, args, {
      encoding: 'buffer',
      timeout,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024
    }, (err, stdout) => {
      if (err && typeof err.code !== 'number') {
        return resolve({ code: -1, buf: Buffer.alloc(0) })
      }
      resolve({ code: err ? err.code : 0, buf: stdout || Buffer.alloc(0) })
    })
  })
}

// 按系统码页解码控制台输出：chcp 探测一次并缓存。zh-CN=936(gbk)、ja=932、ko=949、
// 繁中=950；西文 OEM(437/850) 无 WHATWG 标签，近似用 windows-1252（显示名多为 ASCII，仅重音字符受影响）。
let cpDecoder = null
async function ansiDecoder () {
  if (cpDecoder) return cpDecoder
  const LABELS = {
    936: 'gbk', 950: 'big5', 932: 'shift-jis', 949: 'euc-kr', 866: 'ibm866',
    437: 'windows-1252', 850: 'windows-1252',
    1250: 'windows-1250', 1251: 'windows-1251', 1252: 'windows-1252',
    1253: 'windows-1253', 1254: 'windows-1254', 1255: 'windows-1255',
    1256: 'windows-1256', 1257: 'windows-1257', 65001: 'utf-8'
  }
  let label = 'utf-8'
  try {
    const { stdout } = await run('chcp.com', [], 5000)
    const m = /(\d{3,5})/.exec(String(stdout))
    if (m) label = LABELS[Number(m[1])] || 'utf-8'
  } catch (e) { /* 探测失败按 utf-8：服务名/状态行恒为 ASCII，仅显示名可能受损 */ }
  try { cpDecoder = new TextDecoder(label) } catch (e) { cpDecoder = new TextDecoder() }
  return cpDecoder
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

const SVC_ROOT_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Services'

// 注册表值名不区分大小写（实机见过 DelayedAutoStart/DelayedAutostart 两种拼法）
function regVal (vals, name) {
  const want = name.toLowerCase()
  for (const k of Object.keys(vals)) if (k.toLowerCase() === want) return vals[k]
  return undefined
}

/* ---------------- 服务完整信息（冷路径：sc query + sc qc + reg 单键，零 WMI） ---------------- */
// v1.0.5 整改：v1.0.2~v1.0.4 三次"卡死"拒绝的共同根源是 PowerShell/WMI 冷查询（PS 冷启动
// 秒级起步，审核模板机 WMI 全量查询可慢至超时）。完整信息改用三个纯控制台命令并行（各几十 ms）：
//   sc query <name> → 状态/显示名/可暂停位；sc qc <name> → 启动类型/二进制路径/运行账户；
//   reg query <服务键>（单键全值）→ DelayedAutostart/Description（延迟启动标志仅存于注册表）。
async function getServiceInfo (name, dec) {
  const [q, qc, reg] = await Promise.all([
    runBuf('sc.exe', ['query', name]),
    runBuf('sc.exe', ['qc', name]),
    runBuf('reg.exe', ['query', SVC_ROOT_KEY + '\\' + name])
  ])
  const st = P.parseScQueryOne(dec.decode(q.buf))
  if (!st) return { exists: false, name }
  const cfg = P.parseScQc(dec.decode(qc.buf))
  const vals = P.parseRegValuesByName(dec.decode(reg.buf))
  const delayed = /^0x0*1$/i.test(String(regVal(vals, 'DelayedAutostart') || ''))
  const startType = cfg.startTypeNum === 2 ? (delayed ? 'delayed-auto' : 'auto')
    : cfg.startTypeNum === 4 ? 'disabled' : 'demand'
  return {
    exists: true,
    name,
    displayName: st.displayName || cfg.displayName || name,
    state: st.state,
    startType,
    acceptPause: st.acceptPause,
    account: cfg.account,
    binPath: cfg.binPath,
    description: String(regVal(vals, 'Description') || '')
  }
}
async function getServicesStatus (names) {
  const dec = await ansiDecoder()
  return Promise.all(((names || []).map(String)).filter(Boolean).map(n => getServiceInfo(n, dec)))
}

// 全量服务列表（添加页用）：sc.exe + reg.exe，不依赖 PowerShell/WMI。
// v1.0.3 上架被拒根因：审核环境 CIM 全量查询可慢至超时（界面表现为"点添加卡死"）。
// sc query state= all 一次给出全部 Win32 服务的名称/显示名/状态（~100ms）；
// 启动类型与延迟标志来自注册表两次 /s /v 遍历（各 ~0.4s），三者并行，总耗时 <1s。
// sc 失败或零结果时抛错（让界面给出明确失败与重试）；注册表查询失败仅降级——
// 启动类型标签回退为"手动"（真实服务键必有 Start 值，回退只发生在 reg.exe 被策略禁用时）。
async function listAllServices () {
  const dec = await ansiDecoder()
  const [sc, regStart, regDelayed] = await Promise.all([
    runBuf('sc.exe', ['query', 'state=', 'all']),
    runBuf('reg.exe', ['query', SVC_ROOT_KEY, '/s', '/v', 'Start']),
    runBuf('reg.exe', ['query', SVC_ROOT_KEY, '/s', '/v', 'DelayedAutostart'])
  ])
  if (sc.code !== 0) throw new Error('服务枚举失败：sc.exe 退出码 ' + sc.code)
  const rows = P.parseScQueryAll(dec.decode(sc.buf))
  if (!rows.length) throw new Error('服务枚举失败：sc.exe 未返回任何服务')
  const startMap = P.parseRegDwordByName(dec.decode(regStart.buf), 'Start')
  const delayedSet = new Set(Object.keys(P.parseRegDwordByName(dec.decode(regDelayed.buf), 'DelayedAutostart')))
  // 注册表 Start：2=自动 3=手动 4=禁用（0/1 为引导期驱动，不会出现在 sc 的 Win32 枚举里）
  const stWord = { 2: 'auto', 3: 'demand', 4: 'disabled' }
  return rows.map(r => ({
    exists: true,
    name: r.name,
    displayName: r.displayName || r.name,
    state: r.state,
    startType: (startMap[r.name] === 2 && delayedSet.has(r.name)) ? 'delayed-auto' : (stWord[startMap[r.name]] || 'demand'),
    acceptPause: !!r.acceptPause
  }))
}

/* ---------------- 状态轮询（sc.exe 轻量热路径） ---------------- */
// 进入插件/聚焦时不用 PowerShell：一次 `sc query state= all` 覆盖全量服务状态（单进程、
// 开销约几十 ms），按白名单过滤返回；描述/账户等完整信息按需走 getServicesStatus（展开详情时）。
async function pollStatuses (names) {
  const want = new Set((names || []).map(String))
  if (!want.size) return []
  const { stdout } = await run('sc.exe', ['query', 'state=', 'all'])
  return P.parseScQueryAll(stdout).filter(r => want.has(r.name))
}

// 单服务轻量状态查询（重启等待循环 / MCP 返回状态用）
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

// 管理员身份进程生命周期内不会变化，缓存避免每个进入周期跑两次 net session（冷机最长 8s）
let adminCache = null
async function isAdmin () {
  if (adminCache != null) return adminCache
  adminCache = (await run('net', ['session'], 8000)).code === 0
  return adminCache
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
// 等待上限 60s 且可被 cancelElevatedAuth 中止（v1.0.5：120s 不可取消曾被审核判"卡死"）。
let elevatedJob = null
function cancelElevatedAuth () {
  if (!elevatedJob) return
  elevatedJob.cancelled = true
  try { elevatedJob.child.kill() } catch (e) { /* ignore */ }
}
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
    const { code } = await runPs(launcher, ELEVATED_TIMEOUT, (child) => { elevatedJob = { child, cancelled: false } })
    const cancelled = !!(elevatedJob && elevatedJob.cancelled)
    let res = null
    try { res = JSON.parse(fs.readFileSync(resultPath, 'utf8').replace(/^\uFEFF/, '')) } catch (e) { /* 无结果文件 = UAC 未确认或脚本未执行 */ }
    if (!res && cancelled) {
      // kill 只打到外层 launcher；若提权脚本已确认并在执行，等它最多 2s 写完结果，
      // 避免"ACE 已写入但备份未入账"（真丢了备份时重新授权一次即可补录：已含 ACE 会返回原串）
      for (let i = 0; i < 10 && !res; i++) {
        await new Promise(r => setTimeout(r, 200))
        try { res = JSON.parse(fs.readFileSync(resultPath, 'utf8').replace(/^\uFEFF/, '')) } catch (e) { /* 未生成 */ }
      }
      if (res) return res
    }
    if (!res) {
      return code === 1252
        ? { ok: false, cancelled: true, message: '已取消：未在 UAC 窗口中确认授权' }
        : { ok: false, message: '授权未完成：UAC 提权失败（错误码 ' + code + '）' }
    }
    return res
  } finally {
    elevatedJob = null
    for (const f of [jobPath, resultPath, scriptPath]) { try { fs.unlinkSync(f) } catch (e) { /* ignore */ } }
  }
}

async function grantAuth (names) {
  const list = [...new Set((names || []).map(String))].filter(Boolean)
  if (!list.length) return { ok: true, results: [] }
  const sid = await getUserSid()
  if (!sid) return { ok: false, message: '无法获取当前用户 SID，无法授权' }
  const res = await runElevatedAuth({ services: list, sid })
  const backups = await dbGet(K.auth, {})
  let changed = false
  for (const x of ((res && res.results) || [])) {
    if (x.ok && x.before) { backups[x.name] = x.before; changed = true }
  }
  if (changed) await dbSet(K.auth, backups)
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
  const backups = await dbGet(K.auth, {})
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
      await dbSet(K.auth, backups)
    } else {
      return { ok: false, results }
    }
  }
  return { ok: missing.length === 0, results }
}

async function getAuthBackups () { return dbGet(K.auth, {}) }

/* ---------------- 持久化：utools.db 单后端异步读写 ---------------- */
// v1.0.5 整改：旧版 dbStorage+db 双后端全写+写后读回验证，每次进入插件 ~30 个同步 IPC
// 调用全部阻塞渲染进程（同步 db/dbStorage 是官方文档明确的同步 API），是"连带 uTools
// 一起卡死"的主要根源。改为 utools.db.promises 异步单写（_rev 冲突重试一次），失败回传
// false 由界面 toast；db 未命中时回退读一次旧版写入的 dbStorage 键（双写时代的迁移兼容）。
const K = { wl: 'svc_whitelist', settings: 'svc_settings', auth: 'svc_auth_backup' }
const DEFAULT_SETTINGS = { mcpEnabled: false, mcpWriteEnabled: false }

async function dbGet (key, def) {
  const u = utoolsApi()
  if (u && u.db && u.db.promises) {
    try {
      const d = await u.db.promises.get(key)
      if (d && d.data != null) return d.data
    } catch (e) { console.error('[svc] db.get 失败：' + key, e) }
  }
  if (u && u.dbStorage) {
    try { const v = u.dbStorage.getItem(key); if (v != null) return v } catch (e) { /* ignore */ }
  }
  return def
}

async function dbSet (key, val) {
  const u = utoolsApi()
  if (!u || !u.db || !u.db.promises) {
    console.error('[svc] 写入失败（utools.db 不可用）：' + key)
    return false
  }
  try {
    const cur = await u.db.promises.get(key)
    let r = await u.db.promises.put(cur ? Object.assign({}, cur, { data: val }) : { _id: key, data: val })
    if ((!r || !r.ok) && /rev|conflict/i.test(String((r && r.error) || ''))) {
      const again = await u.db.promises.get(key)
      if (again) r = await u.db.promises.put(Object.assign({}, again, { data: val }))
    }
    if (!r || !r.ok) {
      console.error('[svc] db.put 失败：' + key + ' ' + ((r && r.error) || '未知'))
      return false
    }
    return true
  } catch (e) {
    console.error('[svc] db.put 异常：' + key, e)
    return false
  }
}

async function getWhitelist () {
  const v = await dbGet(K.wl, {})
  const out = Array.isArray(v) ? v : (v && Array.isArray(v.list) ? v.list : [])
  return out
}
async function saveWhitelist (list) {
  // 白名单必须包对象存储：uTools 的 db 不接受顶层数组（会被静默拒绝）
  return dbSet(K.wl, { list: Array.isArray(list) ? list : [] })
}

async function getSettings () { return Object.assign({}, DEFAULT_SETTINGS, await dbGet(K.settings, {})) }
async function saveSettings (patch) {
  const next = Object.assign(await getSettings(), patch || {})
  await dbSet(K.settings, next)
  return next
}

/* ---------------- 审计日志：插件本地数据目录文件（操作记录不入同步库） ---------------- */
// 官方存储规范：操作记录类数据应存 getPluginLocalDataPath() 本地目录，不占同步数据库；
// 旧版把审计写进 db/dbStorage，MCP 每次调用一串同步写也加剧卡顿。
let auditCache = null // 读一次后驻留内存，写时同步更新
let auditPathCache
function auditPath () {
  if (auditPathCache !== undefined) return auditPathCache
  try {
    const u = utoolsApi()
    auditPathCache = (u && u.getPluginLocalDataPath) ? path.join(u.getPluginLocalDataPath(), 'audit.json') : null
  } catch (e) { auditPathCache = null }
  return auditPathCache
}
async function readAudit () {
  if (auditCache) return auditCache
  const p = auditPath()
  if (!p) return []
  try {
    const v = JSON.parse(await fsp.readFile(p, 'utf8'))
    auditCache = Array.isArray(v) ? v : []
  } catch (e) { auditCache = [] }
  return auditCache
}
async function writeAudit (list) {
  auditCache = list
  const p = auditPath()
  if (!p) return
  try { await fsp.writeFile(p, JSON.stringify(list), 'utf8') } catch (e) { console.error('[svc] 审计文件写入失败', e) }
}
async function pushAudit (tool, input, result) {
  const list = await readAudit()
  list.unshift({ ts: Date.now(), tool, input: JSON.parse(JSON.stringify(input || {})), ok: !!(result && result.ok), message: (result && result.message) || '' })
  await writeAudit(list.slice(0, 50))
}
async function getAudit () { return (await readAudit()).slice() }
async function clearAudit () { await writeAudit([]) }

/* ---------------- MCP 工具（plugin.json tools 键必须一一对应） ---------------- */
async function guard (write) {
  const st = await getSettings()
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
        const g = await guard(write)
        result = g || await fn(params || {})
      } catch (e) {
        result = { ok: false, errorCode: 'ERROR', message: String((e && e.message) || e) }
      }
      await pushAudit(tool, params, result)
      return result
    })
  }

  wrap('list_managed_services', false, async () => {
    const wl = await getWhitelist()
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
    return { ok: true, dump: await storageDump() }
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

// 诊断：db 中各键原始内容 + 审计文件内容
async function storageDump () {
  const u = utoolsApi()
  const out = {
    via: u ? (typeof window !== 'undefined' && window.utools ? 'window.utools' : 'global utools') : '未注入',
    hasDb: !!(u && u.db),
    db: {},
    auditFile: null
  }
  if (u && u.db && u.db.promises) {
    for (const k of Object.values(K)) {
      try { const d = await u.db.promises.get(k); out.db[k] = d ? d.data : null } catch (e) { out.db[k] = 'ERR: ' + e.message }
    }
  }
  try { out.auditFile = JSON.parse(await fsp.readFile(auditPath(), 'utf8')) } catch (e) { out.auditFile = null }
  return out
}

// 存储自检（手动触发，设置页入口）：db 异步写读删 + 审计文件落盘校验（绕过内存缓存直写磁盘）
async function storageSelfTest () {
  const u = utoolsApi()
  const out = { ok: false, via: '', backends: {} }
  if (!u || !u.db || !u.db.promises) {
    out.via = '未注入'
    out.backends['-'] = 'utools.db 不可用'
    return out
  }
  out.via = 'utools.db(异步)'
  const id = '__svc_selftest__'
  try {
    const cur = await u.db.promises.get(id)
    const r = await u.db.promises.put(cur ? Object.assign({}, cur, { data: 1 }) : { _id: id, data: 1 })
    if (!r || !r.ok) throw new Error('db.put 失败: ' + ((r && r.error) || '未知'))
    const back = await u.db.promises.get(id)
    const rm = await u.db.promises.remove(id)
    out.backends.db = (back && back.data === 1 && rm && rm.ok) ? 'ok' : '读回不一致'
  } catch (e) { out.backends.db = '失败: ' + e.message }
  try {
    const p = auditPath()
    if (!p) throw new Error('本地数据目录不可用')
    const orig = await fsp.readFile(p, 'utf8').catch(() => null)
    await fsp.writeFile(p, '[{"ts":1,"tool":"__selftest__","ok":true}]', 'utf8')
    const back = JSON.parse(await fsp.readFile(p, 'utf8'))
    if (orig == null) await fsp.unlink(p).catch(() => {})
    else await fsp.writeFile(p, orig, 'utf8')
    auditCache = null
    out.backends.audit = (back[0] && back[0].tool === '__selftest__') ? 'ok' : '读回不一致'
  } catch (e) { out.backends.audit = '失败: ' + e.message }
  out.ok = out.backends.db === 'ok'
  return out
}

appendLog('preload 加载 build=preload-2026-10-15-a via=' + utoolsVia() +
  ' hasDb=' + !!(utoolsApi() && utoolsApi().db))
registerMcpToolsWithRetry(0)
isAdmin().catch(() => {}) // 预热管理员检测缓存：uTools 拉起插件（含 MCP 后台拉起）时即完成一次 net session

/* ---------------- 向渲染进程暴露接口 ---------------- */
window.svcApi = {
  BUILD: 'preload-2026-10-15-a',
  debugLog: (line) => appendLog('[ui] ' + line),
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
  cancelElevatedAuth,
  getAuthBackups,
  getWhitelist,
  saveWhitelist,
  getSettings,
  saveSettings,
  getAudit,
  clearAudit,
  storageDump,
  storageSelfTest,
  START_TYPE_TEXT,
  START_TYPES,
  ERR_TEXT
}
