<script setup>
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
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
const settings = ref({ mcpEnabled: false, mcpWriteEnabled: false })
const storageDiag = ref(null)
const preloadBuild = ref('')
const statusLoaded = ref(false)   // 首次状态查询完成前，卡片显示"获取状态中"而非"查询失败"
const settingsOpen = ref(false)
const audit = ref([])
const toasts = ref([])
let toastId = 0
let timer = null

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

/* ---------- 初始化 / 轮询 ---------- */
async function init () {
  applyTheme()
  try {
    preloadBuild.value = (window.svcApi && window.svcApi.BUILD) || '未检测到（preload 未更新）'
    admin.value = await svc.isAdmin()
    settings.value = store.getSettings()
    whitelist.value = store.getWhitelist()
    storageDiag.value = storageSelfTest()
    await refreshStatuses()
  } catch (e) {
    toast('初始化失败：' + (e && e.message), 'error')
  }
  startPoll()
}
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
function startPoll () { stopPoll(); timer = setInterval(refreshStatuses, 2000) }
function stopPoll () { if (timer) { clearInterval(timer); timer = null } }

onMounted(() => {
  init()
  // utools 桥可能晚于挂载注入：绑定插件生命周期做延迟重试
  const bind = (attempt = 0) => {
    if (window.utools) {
      window.utools.onPluginEnter(() => init())
      window.utools.onPluginOut(() => stopPoll())
    } else if (attempt < 40) {
      setTimeout(() => bind(attempt + 1), 250)
    }
  }
  bind()
})
onUnmounted(stopPoll)

/* ---------- 操作 ---------- */
/* 操作后立即刷新并连续追踪：立即 → 每 600ms 一次，直到状态脱离 pending（最多 8 次 ≈ 5s） */
function refreshBurst (name) {
  let tries = 0
  const tick = async () => {
    tries++
    await refreshStatuses()
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
function requestAdmin () { toast('请在 uTools 中以管理员身份重新运行（右键 uTools 图标 → 以管理员身份运行）') }
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

    <div class="banner" v-if="!admin">
      <span>⚠ uTools 未以管理员身份运行，修改启动类型 / 停止服务可能被拒绝</span>
      <a @click="requestAdmin">以管理员身份重启</a>
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
        <span class="refresh">⟳ 每 2 秒自动刷新</span>
      </div>
      <div class="cards">
        <ServiceCard v-for="w in visibleList" :key="w.name"
                     :name="w.name" :display="w.displayName" :info="live[w.name]"
                     :busy="!!busy[w.name]" :expanded="expanded === w.name" :changed="!!changed[w.name]"
                     :loading="!statusLoaded"
                     @toggle="toggleExpand(w.name)"
                     @action="(a, label) => doAction(w.name, a, { start: '启动', stop: '停止', pause: '暂停', continue: '恢复' }[a])"
                     @restart="doRestart(w.name)"
                     @settype="(t) => doSetType(w.name, t)"
                     @remove="removeSvc(w.name)" />
      </div>
    </template>

    <SettingsModal v-if="settingsOpen" :settings="settings" :audit="audit" :demo="isDemo"
                   :preload-build="preloadBuild" :storage-diag="storageDiag" :ui-build="UI_BUILD"
                   @close="settingsOpen = false" @save="saveSettings" @clear-audit="audit = []; store.clearAudit()" />

    <div class="toasts">
      <div v-for="t in toasts" :key="t.id" class="toast" :class="t.type">{{ t.msg }}</div>
    </div>
  </div>
</template>
