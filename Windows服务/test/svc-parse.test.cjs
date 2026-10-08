'use strict'
// svc-parse.js 最小单测：node test/svc-parse.test.cjs，全过打印 ALL PASS，任一失败抛错退出非 0
const assert = require('assert')
const P = require('../public/preload/svc-parse.js')

/* ---- parseScQueryAll：真实输出格式（含本地化乱码行、多个服务块） ---- */
const QUERY_ALL = [
  '',
  'SERVICE_NAME: Spooler ',
  '        TYPE               : 110  WIN32_OWN_PROCESS  (interactive)',
  '        STATE              : 4  RUNNING ',
  '                                (STOPPABLE, NOT_PAUSABLE, IGNORES_SHUTDOWN)',
  '        WIN32_EXIT_CODE    : 0  (0x0)',
  '',
  'SERVICE_NAME: SysMain',
  '        TYPE               : 20  WIN32_SHARE_PROCESS ',
  '        STATE              : 4  RUNNING ',
  '                                (STOPPABLE, PAUSABLE, ACCEPTS_SHUTDOWN)',
  '',
  'SERVICE_NAME: \uFFFD\uFFFD\uFFFD\u670D\u52A1', // 服务名含 GBK 乱码字节也不影响行解析
  '        STATE              : 1  STOPPED',
  '        [SC] QueryServiceConfig \u6210\u529F', // 本地化尾行
  '',
  'SERVICE_NAME: WSearch',
  '        STATE              : 2  START_PENDING',
  '                                (STOPPABLE, NOT_PAUSABLE, IGNORES_SHUTDOWN)'
].join('\n')

const rows = P.parseScQueryAll(QUERY_ALL)
assert.strictEqual(rows.length, 4, '应解析出 4 个服务块')
assert.deepStrictEqual(rows[0], { name: 'Spooler', state: 'Running', acceptPause: false })
assert.deepStrictEqual(rows[1], { name: 'SysMain', state: 'Running', acceptPause: true })
assert.strictEqual(rows[2].state, 'Stopped')
assert.strictEqual(rows[3].state, 'StartPending')
assert.deepStrictEqual(P.parseScQueryAll(''), [])
assert.strictEqual(P.parseScQueryAll(null).length, 0)

/* ---- parseScQueryOne：单服务查询 ---- */
const one = P.parseScQueryOne('SERVICE_NAME: nginx \n        STATE              : 7  PAUSED \n                                (STOPPABLE, PAUSABLE, IGNORES_SHUTDOWN)')
assert.deepStrictEqual(one, { name: 'nginx', state: 'Paused', acceptPause: true })
assert.strictEqual(P.parseScQueryOne('[SC] OpenService 失败 1060'), null)

/* ---- extractSddl：sdshow 输出 → SDDL 行 ---- */
const SDD_SHOW = '\nD:(A;;CCLCSWLOCRRC;;;AU)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWRPWPDTLOCRRC;;;SY)\n'
const sddl = P.extractSddl(SDD_SHOW)
assert.ok(sddl.startsWith('D:(A;;CCLCSWLOCRRC;;;AU)'), '应取 D: 开头那行')
assert.strictEqual(P.extractSddl('[SC] OpenService 失败 5:\n拒绝访问。'), null)

/* ---- sddlHasRights：默认 ACL 拒绝、插入 ACE 后放行、GA 全权、OA 也算 Allow ---- */
const SID = 'S-1-5-21-3623811015-3361044348-30300820-1001'
assert.strictEqual(P.sddlHasRights(sddl, SID, ['RP', 'WP', 'DC']), false, '默认 ACL 不应授权普通用户')
assert.strictEqual(P.sddlHasRights(sddl, 'BA', ['RP', 'WP', 'DC']), true, 'SDDL 里管理员组是别名 BA，字面匹配应有全权')
assert.strictEqual(P.sddlHasRights(sddl, 'S-1-5-32-544', ['RP', 'WP', 'DC']), false, '别名 BA 与 SID 形式不互配（解析器逐字匹配）')
assert.strictEqual(P.sddlHasRights(sddl, SID, ['RP']), false, '部分权利不满足也应拒绝')
const granted = P.sddlInsertAce(sddl, '(A;;RPWPDTDC;;;' + SID + ')')
assert.ok(granted.startsWith('D:(A;;RPWPDTDC;;;' + SID + ')(A;;CCLCSWLOCRRC;;;AU)'), 'ACE 应插到 D: 段开头')
assert.strictEqual(P.sddlHasRights(granted, SID, ['RP', 'WP', 'DC']), true, '插入后应授权')
assert.strictEqual(P.sddlHasRights('D:(A;;GA;;;BA)', SID, ['RP']), false, 'GA 属于 BA，不影响别的 SID')
assert.strictEqual(P.sddlHasRights('D:(A;;GA;;;' + SID + ')', SID, ['RP', 'WP', 'DC']), true, 'GA 覆盖所需权利')
assert.strictEqual(P.sddlHasRights('D:(OA;;RP;;;' + SID + ')', SID, ['RP']), true, 'OA 也是 Allow')
assert.strictEqual(P.sddlHasRights('D:(D;;RP;;;' + SID + ')', SID, ['RP']), false, 'Deny ACE 不算授权')
assert.strictEqual(P.sddlHasRights('D:(A;;RP;;;' + SID + '-x)', SID, ['RP']), false, 'trustee 须整串相等')

/* ---- sddlInsertAce：非 D: 开头必须拒绝（宁可失败也不写坏描述符） ---- */
assert.strictEqual(P.sddlInsertAce('O:SYG:BAD:(A;;RP;;;BA)', '(A;;RP;;;X)'), null)
assert.strictEqual(P.sddlInsertAce(null, '(A;;RP;;;X)'), null)

/* ---- parseWhoamiSid：CSV 末列 SID ---- */
assert.strictEqual(P.parseWhoamiSid('"DESKTOP\\user","S-1-5-21-3623811015-3361044348-30300820-1001"\r\n'), SID)
assert.strictEqual(P.parseWhoamiSid(''), null)

/* ---- AUTH_PS1：结构完整且可在 JS 模板/PS 单引号下安全传输 ---- */
assert.ok(P.AUTH_PS1.includes('param($JobPath, $ResultPath)'))
assert.ok(P.AUTH_PS1.includes('sdset'))
assert.ok(P.AUTH_PS1.includes('ConvertTo-Json'))
assert.ok(!/[`]/.test(P.AUTH_PS1), 'PS1 不得含反引号（避免转义问题）')
assert.ok(!/\$\{/.test(P.AUTH_PS1), 'PS1 不得含 ${（避免被当作插值）')

/* ---- 撤销 job 契约：必须带 services 数组，缺省会让 AUTH_PS1 以 $null 迭代一次 ----
   复现线上 bug「撤销失败：索引操作失败；数组索引的计算结果为 Null」：
   @($null) 是含一个 $null 元素的数组，$backups.PSObject.Properties[$null] 即抛该错。
   services.js 构造撤销 job 时必须同时传 services 与 backups。 */
{
  const { execFileSync } = require('child_process')
  const ps = [
    '$bad = \'{"revoke":true,"backups":{"Redis":"D:(A;;RP;;;BA)"}}\' | ConvertFrom-Json',
    '$badErr = $false',
    'try { foreach ($n in @($bad.services)) { $null = $bad.backups.PSObject.Properties[$n].Value } } catch { $badErr = $true }',
    '$good = \'{"revoke":true,"services":["Redis"],"backups":{"Redis":"D:(A;;RP;;;BA)"}}\' | ConvertFrom-Json',
    '$goodVal = \'\'',
    'try { foreach ($n in @($good.services)) { $goodVal = [string]$good.backups.PSObject.Properties[$n].Value } } catch { $goodVal = \'ERR\' }',
    '"BAD_ERR=" + $badErr',
    '"GOOD_VAL=" + $goodVal'
  ].join('\n')
  const enc = Buffer.from(ps, 'utf16le').toString('base64')
  const out = execFileSync('powershell.exe', ['-NoProfile', '-EncodedCommand', enc], { encoding: 'utf8', timeout: 30000 })
  assert.ok(out.includes('BAD_ERR=True'), '缺 services 的撤销 job 必须复现索引报错：\n' + out)
  assert.ok(out.includes('GOOD_VAL=D:(A;;RP;;;BA)'), '带 services 的撤销 job 应能取回备份 SDDL：\n' + out)
}

console.log('ALL PASS:', rows.length, 'blocks parsed,', Object.keys(P).length, 'exports verified')
