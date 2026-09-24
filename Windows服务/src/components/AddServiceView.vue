<script setup>
import { computed, onMounted, ref } from 'vue'
import { svc, START_TYPE_TEXT } from '../lib/backend.js'

const props = defineProps({
  addedSet: { type: Object, required: true }   // Set<name>
})
const emit = defineEmits(['back', 'add', 'remove'])

const rows = ref(null)   // null=加载中
const loadError = ref('')
const q = ref('')

onMounted(async () => {
  try {
    rows.value = await svc.listAll()
  } catch (e) {
    rows.value = []
    loadError.value = '服务列表加载失败：' + ((e && e.message) || e)
  }
})

const filtered = computed(() => {
  if (!rows.value) return []
  const kw = q.value.trim().toLowerCase()
  if (!kw) return rows.value
  return rows.value.filter(r => (r.name + ' ' + (r.displayName || '')).toLowerCase().includes(kw))
})
const stateWord = (s) => ({ Running: '运行中', Stopped: '已停止', Paused: '已暂停' }[s] || s || '未知')
</script>

<template>
  <div class="searchrow">
    <input v-model="q" placeholder="🔍 搜索服务名或显示名" autofocus />
  </div>
  <div class="addlist">
    <template v-if="rows === null">
      <div class="skel" v-for="i in 5" :key="i"></div>
    </template>
    <template v-else-if="loadError">
      <div class="audit-empty" style="color:var(--red)">{{ loadError }}</div>
    </template>
    <template v-else-if="!filtered.length">
      <div class="audit-empty">没有匹配的服务</div>
    </template>
    <template v-else>
      <div class="addrow" v-for="r in filtered" :key="r.name">
        <span class="dot" :class="r.state || 'Unknown'"></span>
        <span class="nm">{{ r.displayName || r.name }}</span>
        <span class="sn">{{ r.name }}</span>
        <span class="tag" :class="'ty-' + (r.startType === 'disabled' ? 'disabled' : r.startType === 'auto' ? 'auto' : 'demand')">
          <template v-if="r.startType === 'delayed-auto'">⏱ 自动(延迟启动)</template>
          <template v-else>{{ START_TYPE_TEXT[r.startType] || r.startType }}</template>
        </span>
        <span class="sw" :class="'sw-' + r.state" style="font-size:12px">{{ stateWord(r.state) }}</span>
        <button v-if="addedSet.has(r.name)" class="btn" disabled>已添加</button>
        <button v-else class="btn primary" @click="emit('add', r)">＋ 添加</button>
      </div>
    </template>
  </div>
</template>
