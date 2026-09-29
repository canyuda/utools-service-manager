'use strict'
// 纯解析/构造模块：sc.exe 输出、SDDL 安全描述符、授权 PS1 脚本。
// 不依赖运行时环境（Node 单测 / uTools preload 通用），由 services.js require。

/* ---------------- sc.exe 查询输出解析 ---------------- */
// SERVICE_NAME / STATE / PAUSABLE 等结构行恒为英文 ASCII；本地化消息（如"[SC] 成功"）
// 的 GBK 字节被 utf8 解出的乱码只出现在无关行，正则天然跳过。
const SC_STATE_WORD = {
  RUNNING: 'Running',
  STOPPED: 'Stopped',
  PAUSED: 'Paused',
  START_PENDING: 'StartPending',
  STOP_PENDING: 'StopPending',
  PAUSE_PENDING: 'PausePending',
  CONTINUE_PENDING: 'ContinuePending'
}

// 解析 `sc query` / `sc query state= all` 输出 → [{ name, state, acceptPause }]
function parseScQueryBlocks (stdout) {
  const rows = []
  if (!stdout) return rows
  const blocks = String(stdout).split(/^SERVICE_NAME:[ \t]*/m)
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i]
    const nl = block.indexOf('\n')
    const name = (nl === -1 ? block : block.slice(0, nl)).trim()
    if (!name) continue
    const sm = /STATE[ \t]*:[ \t]*\d+[ \t]+([A-Z_]+)/.exec(block)
    if (!sm) continue
    rows.push({
      name,
      state: SC_STATE_WORD[sm[1]] || sm[1],
      // \bPAUSABLE\b 不会误匹配 NOT_PAUSABLE（下划线是词字符，无边界）
      acceptPause: /\bPAUSABLE\b/.test(block)
    })
  }
  return rows
}

function parseScQueryAll (stdout) { return parseScQueryBlocks(stdout) }
function parseScQueryOne (stdout) { return parseScQueryBlocks(stdout)[0] || null }

/* ---------------- SDDL 安全描述符 ---------------- */
// 从 `sc sdshow` 输出提取 SDDL（D: 开头那一行）
function extractSddl (stdout) {
  if (!stdout) return null
  for (const line of String(stdout).split(/\r?\n/)) {
    const t = line.trim()
    if (/^D:\(/.test(t)) return t
  }
  return null
}

// 判断 SDDL 中是否存在授予 sid 全部所需权利的 Allow ACE（rights 如 ['RP','WP','DC']）。
// ACE 格式：(type;flags;rights;objGUID;inheritGUID;trustee)；GA(GENERIC_ALL) 覆盖一切权利。
function sddlHasRights (sddl, sid, rights) {
  if (!sddl || !sid) return false
  const need = rights || []
  const aceRe = /\(([^();]*);[^;]*;([^;]*);[^;]*;[^;]*;([^)]*)\)/g
  let m
  while ((m = aceRe.exec(String(sddl))) !== null) {
    const type = m[1]
    const rightsStr = m[2]
    const trustee = m[3].trim().toUpperCase()
    if (type !== 'A' && type !== 'OA') continue
    if (trustee !== String(sid).toUpperCase()) continue
    if (/GA/.test(rightsStr)) return true
    if (need.every(r => rightsStr.includes(r))) return true
  }
  return false
}

// 把 ACE 插入 DACL 段开头（只替换 "D:" 标记，不能吃掉第一个 ACE 的开括号）；
// SDDL 不是 D: 开头时返回 null（宁可失败也不写坏安全描述符）
function sddlInsertAce (sddl, ace) {
  const s = String(sddl || '')
  if (!/^D:/.test(s)) return null
  return s.replace(/^D:/, 'D:' + ace)
}

/* ---------------- whoami SID ---------------- */
// `whoami /user /fo csv /nh` → 用户 SID（取最后一个匹配，避开机器名等误配）
function parseWhoamiSid (stdout) {
  const all = String(stdout || '').match(/S-1-\d+(?:-\d+)+/g) || []
  return all.length ? all[all.length - 1] : null
}

/* ---------------- 授权 PS1（提权进程执行，路径经参数传入） ---------------- */
// 授权：sdshow 读原串 → DACL 头部插入 (A;;RPWPDTDC;;;sid)（启动/停止/暂停恢复/改启动类型）
//   → sdset 写回；已含该 ACE 则跳过。
// 撤销：用 job.backups 里的原串 sdset 还原。
// 逐服务 try/catch，结果写回 ResultPath（UTF-8 BOM，由 Node 端剥离）。
// 注意：只能在 grant 时备份原串；授权后若服务被重装/ACL 被他人改动，撤销会整体还原为授权时刻的原串。
const AUTH_PS1 = [
  'param($JobPath, $ResultPath)',
  "$ErrorActionPreference = 'Continue'",
  '$job = Get-Content -Raw -Encoding UTF8 $JobPath | ConvertFrom-Json',
  '$results = @()',
  'foreach ($n in @($job.services)) {',
  '  try {',
  '    if ($job.revoke) {',
  '      $before = $job.backups.PSObject.Properties[$n].Value',
  "      if (-not $before) { throw ('no backup SDDL for ' + $n) }",
  '      $r = sc.exe sdset $n $before 2>&1',
  "      if ($LASTEXITCODE -ne 0) { throw ('sdset failed: ' + [string]($r -join ' ')) }",
  '      $results += @{ name = $n; ok = $true }',
  '    } else {',
  '      $lines = sc.exe sdshow $n 2>&1',
  "      $sddl = [string]@($lines | Where-Object { [string]$_ -match '^D:\\(' })[0]",
  "      if (-not $sddl) { throw '未读到服务安全描述符（服务可能不存在或名称有误）' }",
  "      $need = '(A;;RPWPDTDC;;;' + $job.sid + ')'",
  '      if ($sddl.Contains($need)) {',
  '        $results += @{ name = $n; ok = $true; before = $sddl; after = $sddl; already = $true }',
  '      } else {',
  "        $new = $sddl -replace '^D:', ('D:' + $need)",
  "        if ($new -eq $sddl) { throw 'SDDL 格式意外（D: 段不在开头），为安全起见未修改' }",
  '        $r = sc.exe sdset $n $new 2>&1',
  "        if ($LASTEXITCODE -ne 0) { throw ('sdset failed: ' + [string]($r -join ' ')) }",
  '        $results += @{ name = $n; ok = $true; before = $sddl; after = $new }',
  '      }',
  '    }',
  '  } catch {',
  '    $results += @{ name = $n; ok = $false; error = [string]$_.Exception.Message }',
  '  }',
  '}',
  '$summary = @{ ok = $true; results = $results }',
  'foreach ($x in $results) { if (-not $x.ok) { $summary.ok = $false } }',
  '$summary | ConvertTo-Json -Compress -Depth 5 | Set-Content -Encoding UTF8 $ResultPath',
  'exit 0'
].join('\n')

module.exports = {
  SC_STATE_WORD,
  parseScQueryAll,
  parseScQueryOne,
  extractSddl,
  sddlHasRights,
  sddlInsertAce,
  parseWhoamiSid,
  AUTH_PS1
}
