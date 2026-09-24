<script setup>
import { computed, ref, watch } from 'vue'
import { START_TYPE_TEXT, START_TYPES } from '../lib/backend.js'

const props = defineProps({
  name: { type: String, required: true },
  display: { type: String, default: '' },
  info: { type: Object, default: null },   // 轮询回来的服务信息（可能 null=尚未轮询到）
  busy: { type: Boolean, default: false },
  expanded: { type: Boolean, default: false },
  changed: { type: Boolean, default: false },
  loading: { type: Boolean, default: false }  // 首次状态查询尚未完成
})
const emit = defineEmits(['toggle', 'action', 'restart', 'settype', 'remove'])

const PENDING_WORD = { StartPending: '正在启动…', StopPending: '正在停止…' }

const exists = computed(() => !props.info || props.info.exists !== false)
const state = computed(() => {
  if (props.busy) return 'Processing'
  if (!props.info) return props.loading ? 'Loading' : 'Unknown'
  if (props.info.exists === false) return 'Unknown'
  return props.info.state || 'Unknown'
})
const stateWord = computed(() => {
  if (state.value === 'Loading') return '获取状态中…'
  if (props.busy && props.info && !['StartPending', 'StopPending'].includes(props.info.state)) return '处理中…'
  if (props.info && PENDING_WORD[props.info.state]) return PENDING_WORD[props.info.state]
  if (!exists.value) return '服务不存在'
  if (state.value === 'Unknown') return '查询失败'
  const w = { Running: '运行中', Stopped: '已停止', Paused: '已暂停' }
  return w[state.value] || state.value
})
const stateWordClass = computed(() => (['StartPending', 'StopPending'].includes(props.info?.state) ? 'sw-Pending' : 'sw-' + state.value))

// 操作可用性矩阵：Running→停止/重启(+可暂停时暂停)；Paused→停止/恢复/重启；Stopped→启动
const legal = computed(() => {
  const st = props.info && props.info.state
  if (props.busy || !exists.value) return []
  if (st === 'Running') return props.info.acceptPause ? ['stop', 'pause', 'restart'] : ['stop', 'restart']
  if (st === 'Paused') return ['stop', 'resume', 'restart']
  if (st === 'Stopped') return ['start']
  return []
})
const OPS = [
  { k: 'start', icon: '▶', label: '启动', action: 'start' },
  { k: 'stop', icon: '■', label: '停止', action: 'stop' },
  { k: 'pause', icon: '⏸', label: '暂停', action: 'pause' },
  { k: 'resume', icon: '⏵', label: '恢复', action: 'continue' },
  { k: 'restart', icon: '↻', label: '重启', restart: true }
]
const inlineOps = computed(() => OPS.filter(o => legal.value.includes(o.k)))

// 启动类型修改：两步确认（禁用为高危，红色强调）
const pendingType = ref('')
watch(() => props.info && props.info.startType, () => { pendingType.value = '' })
function onTypeChange (e) {
  const t = e.target.value
  const want = Object.keys(START_TYPE_TEXT).find(k => START_TYPE_TEXT[k] === t)
  if (!want || want === (props.info && props.info.startType)) { e.target.value = START_TYPE_TEXT[props.info?.startType] || t; return }
  pendingType.value = want
}
function confirmType () {
  emit('settype', pendingType.value)
  pendingType.value = ''
}
function cancelType () { pendingType.value = '' }
const typeText = computed(() => START_TYPE_TEXT[props.info?.startType] || props.info?.startType || '—')
</script>

<template>
  <div class="card">
    <div class="row" @click="emit('toggle')">
      <span class="dot" :class="state"></span>
      <div class="mid">
        <div class="name">{{ display || name }}<span v-if="changed" style="font-size:11px;color:var(--blue)">有变化</span></div>
        <div class="sub">{{ name }} · <span :class="stateWordClass">{{ stateWord }}</span></div>
      </div>
      <span class="tag" :class="'ty-' + (info?.startType || 'demand')" style="border-color:var(--border);color:var(--sub)" v-if="!info">{{ '…' }}</span>
      <span v-else class="tag" :class="'ty-' + (info.startType === 'disabled' ? 'disabled' : info.startType === 'auto' ? 'auto' : 'demand')">
        <template v-if="info.startType === 'delayed-auto'">⏱ 自动(延迟启动)</template>
        <template v-else>{{ typeText }}</template>
      </span>
      <span class="acts" @click.stop>
        <button v-for="o in inlineOps" :key="o.k" class="op" :class="o.k" :disabled="busy"
                :title="o.label" @click="o.restart ? emit('restart') : emit('action', o.action)">{{ o.icon }}</button>
      </span>
    </div>

    <div v-if="expanded" class="detail" @click.stop>
      <template v-if="!exists">
        <div class="kv"><span class="k">状态</span><span class="v" style="color:var(--red)">服务不存在，可能已被卸载，可从列表移除。</span></div>
      </template>
      <template v-else>
        <div class="kv"><span class="k">服务名</span><span class="v">{{ info?.name || name }}</span></div>
        <div class="kv" v-if="info?.displayName"><span class="k">显示名</span><span class="v">{{ info.displayName }}</span></div>
        <div class="kv" v-if="info?.description"><span class="k">描述</span><span class="v">{{ info.description }}</span></div>
        <div class="kv" v-if="info?.binPath"><span class="k">二进制</span><span class="v">{{ info.binPath }}</span></div>
        <div class="kv" v-if="info?.account"><span class="k">账户</span><span class="v">{{ info.account }}</span></div>
        <div class="kv">
          <span class="k">启动类型</span>
          <span class="v" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
            <select class="starttype" :disabled="busy" :value="typeText" @change="onTypeChange">
              <option v-for="(t, k) in START_TYPE_TEXT" :key="k">{{ t }}</option>
            </select>
            <span v-if="pendingType" class="confirm-type" :class="{ danger: pendingType === 'disabled' }">
              {{ pendingType === 'disabled' ? '禁用后重启不再随系统启动' : `改为【${START_TYPE_TEXT[pendingType]}】？` }}
              <button class="mini-btn primary" @click="confirmType">确认</button>
              <button class="mini-btn" @click="cancelType">取消</button>
            </span>
          </span>
        </div>
        <div class="ops">
          <button v-for="o in OPS" :key="o.k" class="op big" :class="o.k"
                  :disabled="busy || !legal.includes(o.k)"
                  @click="o.restart ? emit('restart') : emit('action', o.action)">{{ o.icon }} {{ o.label }}</button>
        </div>
        <div class="foot">
          <span style="font-size:11.5px;color:var(--sub)">每 2 秒自动刷新</span>
          <span class="remove"><a @click="emit('remove')">从列表移除</a></span>
        </div>
      </template>
    </div>
  </div>
</template>
