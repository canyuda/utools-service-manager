<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import ServiceCard from './components/ServiceCard.vue'
import AddServiceView from './components/AddServiceView.vue'
import SettingsModal from './components/SettingsModal.vue'
import { svc, isDemo } from './lib/backend.js'
import * as store from './lib/store.js'
import { storageSelfTest, BUILD as UI_BUILD } from './lib/store.js'

/* ---------- 视图与状态 ---------- */
const view = ref('main')            // main | add
const whitelist = ref([])           // [{ name, displayName }]
const live = reactive({})           // name -> 轮询到的服务信息
const busy = reactive({})
const changed = reactive({})
const expanded = ref(null)
const filter = ref('all')
const admin = ref(true)
const authMap = reactive({})        // name -> 是否已授权（undefined = 尚未检查，按已授权渲染避免闪烁）
const granting = ref(false)
const authNames = ref([])           // 已授权（有备份原串）的服务名列表
const settings = ref({ mcpEnabled: false, mcpWriteEnabled: false })
const storageDiag = ref(null)
const preloadBuild = ref('')
const statusLoaded = ref(false)   // 首次状态查询完成前，卡片显示"获取状态中"而非"查询失败"
const settingsOpen = ref(false)
const audit = ref([])
const toasts = ref([])
let toastId = 0

/* ---------- Toast ---------- */
function toast (msg, type = 'info') {
  const id = ++toastId
  toasts.value.push({ id, msg, type })
  setTimeout(() => { toasts.value = toasts.value.filter(t => t.id !== id) }, type === 'error' ? 6000 : 2500)
}

/* ---------- 主题 ---------- */
function applyTheme () {
  let dark = false
  try {
    dark = window.utools && window.utools.isDarkColors ? window.utools.isDarkColors() : false
  } catch (e) { /* ignore */ }
  if (!dark && window.matchMedia) dark = window.matchMedia('(prefers-color-scheme: dark)').matches
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
}

/* ---------- 初始化 / 刷新 ---------- */
async function init () {
  applyTheme()
  try {
    preloadBuild.value = (window.svcApi && window.svcApi.BUILD) || '未检测到（preload 未更新）'
    admin.value = await svc.isAdmin()
    settings.value = store.getSettings()
    whitelist.value = store.getWhitelist()
    storageDiag.value = storageSelfTest()
    await refreshStatuses()
    await refreshAuth()
  } catch (e) {
    toast('初始化失败：' + (e && e.message), 'error')
  }
}
/* 全量刷新（PowerShell 冷路径）：仅进入插件时调用，取启动类型/显示名等完整信息 */
async function refreshStatuses () {
  const names = whitelist.value.map(w => w.name)
  if (!names.length) return
  let rows = []
  try {
    rows = await svc.getStatuses(names)
    statusLoaded.value = true
  } catch (e) { return }
  for (const r of rows) {
    const old = live[r.name]
    if (old && old.state && r.state && old.state !== r.state && !busy[r.name]) {
      changed[r.name] = true
      setTimeout(() => { delete changed[r.name] }, 900)
    }
    live[r.name] = r
  }
}
/* 轻量刷新（sc.exe 热路径）：只刷新状态/可暂停位，与已缓存的完整信息合并。
   不做后台定时轮询：uTools 隐藏/窗口遮挡时 Chromium 会冻结定时器，静置轮询既浪费
   也会让界面停在过期帧（上架审核"无操作一段时间后卡死"根因）。改为事件驱动：
   进入插件 / 窗口重新可见或聚焦 / 操作后 burst / 手动点刷新。 */
async function pollTick () {
  const names = whitelist.value.map(w => w.name)
  if (!names.length) return
  let rows = []
  try {
    rows = await svc.pollStatuses(names)
  } catch (e) { return }
  for (const r of rows) {
    const old = live[r.name]
    if (old && old.state && r.state && old.state !== r.state && !busy[r.name]) {
      changed[r.name] = true
      setTimeout(() => { delete changed[r.name] }, 900)
    }
    live[r.name] = Object.assign({}, live[r.name], r)
  }
}

onMounted(() => {
  init()
  // utools 桥可能晚于挂载注入：绑定插件进入做延迟重试
  const bind = (attempt = 0) => {
    if (window.utools) {
      window.utools.onPluginEnter(() => init())
    } else if (attempt < 40) {
      setTimeout(() => bind(attempt + 1), 250)
    }
  }
  bind()
  // 回到插件（窗口重新可见/聚焦）时轻量刷新一次，替代原 2 秒轮询
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') pollTick() })
  window.addEventListener('focus', pollTick)
})

/* ---------- 操作 ---------- */
/* 操作后立即刷新并连续追踪：立即 → 每 600ms 一次，直到状态脱离 pending（最多 8 次 ≈ 5s） */
function refreshBurst (name) {
  let tries = 0
  const tick = async () => {
    tries++
    await pollTick()
    const st = live[name]
    const pending = !!st && ['StartPending', 'StopPending'].includes(st.state)
    if (tries < 8 && (pending || tries < 2)) setTimeout(tick, 600)
  }
  setTimeout(tick, 0)
}

async function doAction (name, action, label) {
  if (busy[name]) return
  busy[name] = true
  try {
    const r = await svc.control(name, action)
    if (r.ok) toast(`${name} ${label}成功`, 'ok')
    else toast(`${name} ${label}失败：${r.message}`, 'error')
    if (!r.ok && r.errorCode === 5) authMap[name] = false // 实际被拒说明授权失效/缺失，兜底纠正
  } catch (e) {
    toast(`${name} ${label}失败：${(e && e.message) || e}`, 'error')
  } finally { busy[name] = false }
  refreshBurst(name)
}
async function doRestart (name) {
  if (busy[name]) return
  busy[name] = true
  toast(`${name} 正在重启…`)
  try {
    const r = await svc.restart(name)
    if (r.ok) toast(`${name} 重启成功`, 'ok')
    else toast(`${name} 重启失败：${r.message}`, 'error')
    if (!r.ok && r.errorCode === 5) authMap[name] = false
  } catch (e) {
    toast(`${name} 重启失败：${(e && e.message) || e}`, 'error')
  } finally { busy[name] = false }
  refreshBurst(name)
}
async function doSetType (name, t) {
  if (busy[name]) return
  busy[name] = true
  try {
    const r = await svc.setStartType(name, t)
    if (r.ok) toast(`${name} 启动类型已修改`, 'ok')
    else toast(`${name} 修改失败：${r.message}`, 'error')
    if (!r.ok && r.errorCode === 5) authMap[name] = false
  } catch (e) {
    toast(`${name} 修改失败：${(e && e.message) || e}`, 'error')
  } finally { busy[name] = false }
  refreshBurst(name)
}
async function addSvc (row) {
  if (addedSet.value.has(row.name)) return
  whitelist.value = [...whitelist.value, { name: row.name, displayName: row.displayName || row.name }]
  const r = store.saveWhitelist(whitelist.value)
  const env = {
    rendererHasUtools: !!window.utools,
    rendererHasDbStorage: !!(window.utools && window.utools.dbStorage),
    rendererHasDb: !!(window.utools && window.utools.db)
  }
  if (svc.debugLog) svc.debugLog('addSvc ' + row.name + ' result=' + JSON.stringify(r) + ' env=' + JSON.stringify(env) + ' whitelist=' + JSON.stringify(whitelist.value))
  if (r.ok) toast(`已添加 ${row.name}`, 'ok')
  else toast(`保存失败：${r.errors.join('；')}`, 'error')
  // 新卡片先补一次全量信息（含启动类型），轮询热路径只更新状态
  svc.getStatuses([row.name]).then(rows => {
    if (rows[0]) live[rows[0].name] = Object.assign({}, live[rows[0].name], rows[0])
  }).catch(() => {})
  refreshAuth([row.name])
  refreshBurst(row.name)
}
function removeSvc (name) {
  whitelist.value = whitelist.value.filter(w => w.name !== name)
  const r = store.saveWhitelist(whitelist.value)
  if (!r.ok) toast(`保存失败：${r.errors.join('；')}`, 'error')
  delete live[name]
  if (expanded.value === name) expanded.value = null
  toast(`已从列表移除 ${name}`)
}

/* ---------- 设置 ---------- */
function openSettings () {
  settingsOpen.value = true
  audit.value = store.getAudit()
  refreshAuthNames()
}
function saveSettings (patch) {
  settings.value = store.saveSettings(patch)
  toast('设置已保存', 'ok')
}

/* ---------- 计算属性 ---------- */
const addedSet = computed(() => new Set(whitelist.value.map(w => w.name)))
const counts = computed(() => {
  const c = { all: whitelist.value.length, Running: 0, Stopped: 0, Paused: 0 }
  for (const w of whitelist.value) {
    const st = live[w.name] && live[w.name].state
    if (c[st] != null) c[st]++
  }
  return c
})
const visibleList = computed(() => {
  if (filter.value !== 'all') {
    return whitelist.value.filter(w => live[w.name] && live[w.name].state === filter.value)
  }
  return whitelist.value
})
function toggleExpand (name) { expanded.value = expanded.value === name ? null : name }
const unauthNames = computed(() => whitelist.value
  .filter(w => !admin.value && authMap[w.name] === false)
  .map(w => w.name))
/* ---------- 授权（按服务一次性 SDDL 授权，UAC 确认） ---------- */
async function refreshAuth (names) {
  const list = names || whitelist.value.map(w => w.name)
  if (!list.length) return
  try {
    if (admin.value) {
      list.forEach(n => { authMap[n] = true })
      return
    }
    Object.assign(authMap, await svc.checkAuth(list))
  } catch (e) { /* 检查失败不拦界面；写操作失败（error 5）时会兜底纠正 */ }
}
async function grantAuth (names) {
  if (granting.value || !names.length) return
  granting.value = true
  toast(names.length > 1
    ? `正在为 ${names.length} 个服务授权，请在弹出的 UAC 窗口点「是」…`
    : `正在为 ${names[0]} 授权，请在弹出的 UAC 窗口点「是」…`)
  try {
    const r = await svc.grantAuth(names)
    for (const x of ((r && r.results) || [])) if (x.ok) authMap[x.name] = true
    if (r && r.ok) toast('授权完成，已可控制所选服务', 'ok')
    else if (r && r.cancelled) toast('授权已取消，服务保持只读', 'error')
    else {
      const fails = ((r && r.results) || []).filter(x => !x.ok)
      toast(fails.length
        ? '授权部分失败：' + fails.map(x => `${x.name}（${x.error || '未知'}）`).join('；')
        : '授权失败：' + ((r && r.message) || '未知错误'), 'error')
    }
  } catch (e) {
    toast('授权失败：' + ((e && e.message) || e), 'error')
  } finally { granting.value = false }
  await refreshAuth(names)
  refreshAuthNames()
}
function grantAll () { grantAuth(unauthNames.value.slice()) }
async function revokeOne (name) { doRevoke([name]) }
function revokeAll () { doRevoke(authNames.value.slice()) }
/* 批量撤销：一次 UAC 完成全部，逐个 ok 的才更新 authMap；结束后重读备份库刷新列表 */
async function doRevoke (list) {
  if (!list.length) return
  try {
    const r = await svc.revokeAuth(list)
    const okNames = ((r && r.results) || []).filter(x => x.ok).map(x => x.name)
    okNames.forEach(n => { authMap[n] = false })
    if (r && r.ok) {
      toast(list.length === 1 ? `已撤销 ${list[0]} 的授权` : `已撤销 ${okNames.length} 个服务的授权`, 'ok')
    } else {
      const fail = ((r && r.results) || []).find(x => !x.ok)
      toast(`撤销失败：${(fail && fail.error) || (r && r.message) || '未知错误'}`, 'error')
    }
  } catch (e) {
    toast('撤销失败：' + ((e && e.message) || e), 'error')
  }
  refreshAuthNames()
}
async function refreshAuthNames () {
  try { authNames.value = Object.keys(await svc.getAuthBackups() || {}) } catch (e) { /* ignore */ }
}
</script>

<template>
  <div class="app-root">
    <div class="topbar">
      <template v-if="view === 'add'">
        <button class="btn icon" @click="view = 'main'">←</button>
        <h1>添加服务</h1>
      </template>
      <template v-else>
        <h1>Windows 服务管理 <span v-if="isDemo" class="demo-chip">浏览器演示模式</span></h1>
        <button class="btn icon" title="设置（MCP / 审计日志）" @click="openSettings">⚙</button>
        <button class="btn primary" @click="view = 'add'">＋ 添加服务</button>
      </template>
    </div>

    <div class="banner" v-if="!admin && unauthNames.length">
      <span>⚠ {{ unauthNames.length }} 个服务未授权：可查看状态，控制前需先授权</span>
      <a @click="grantAll">一键授权（UAC 确认）</a>
    </div>
    <div class="banner" v-if="storageDiag && !storageDiag.ok" style="color:var(--red);background:var(--red-bg)">
      <span>⚠ 本地存储不可用（{{ storageDiag.error }} · {{ storageDiag.via }}），重开后数据不会保存</span>
    </div>

    <template v-if="view === 'add'">
      <AddServiceView :added-set="addedSet" @back="view = 'main'" @add="addSvc" />
    </template>
    <template v-else-if="!whitelist.length">
      <div class="empty">
        <div class="gear">⚙</div>
        <p>还没有添加服务，点击右上角 ＋ 添加服务</p>
        <p style="font-size:12px">把 Redis、Consul、nginx 等常用服务加入管理</p>
        <button class="btn primary" @click="view = 'add'">＋ 添加服务</button>
      </div>
    </template>
    <template v-else>
      <div class="filterbar">
        <span class="ftab" :class="{ on: filter === 'all' }" @click="filter = 'all'">全部<span class="n">{{ counts.all }}</span></span>
        <span class="ftab" :class="{ on: filter === 'Running' }" @click="filter = 'Running'">运行中<span class="n">{{ counts.Running }}</span></span>
        <span class="ftab" :class="{ on: filter === 'Stopped' }" @click="filter = 'Stopped'">已停止<span class="n">{{ counts.Stopped }}</span></span>
        <span class="ftab" :class="{ on: filter === 'Paused' }" @click="filter = 'Paused'">已暂停<span class="n">{{ counts.Paused }}</span></span>
        <span class="refresh" title="刷新状态（进入插件或窗口聚焦时也会自动刷新）" @click="pollTick">⟳ 刷新</span>
      </div>
      <div class="cards">
        <ServiceCard v-for="w in visibleList" :key="w.name"
                     :name="w.name" :display="w.displayName" :info="live[w.name]"
                     :busy="!!busy[w.name]" :expanded="expanded === w.name" :changed="!!changed[w.name]"
                     :loading="!statusLoaded" :authed="admin || authMap[w.name] !== false"
                     @toggle="toggleExpand(w.name)"
                     @action="(a, label) => doAction(w.name, a, { start: '启动', stop: '停止', pause: '暂停', continue: '恢复' }[a])"
                     @restart="doRestart(w.name)"
                     @settype="(t) => doSetType(w.name, t)"
                     @authorize="grantAuth([w.name])"
                     @remove="removeSvc(w.name)" />
      </div>
    </template>

    <SettingsModal v-if="settingsOpen" :settings="settings" :audit="audit" :demo="isDemo"
                   :preload-build="preloadBuild" :storage-diag="storageDiag" :ui-build="UI_BUILD"
                   :auth-names="authNames" :granting="granting"
                   @close="settingsOpen = false" @save="saveSettings" @clear-audit="audit = []; store.clearAudit()"
                   @revoke="revokeOne" @revoke-all="revokeAll" />

    <div class="toasts">
      <div v-for="t in toasts" :key="t.id" class="toast" :class="t.type">{{ t.msg }}</div>
    </div>
  </div>
</template>
