<script setup>
import { computed } from 'vue'

const props = defineProps({
  settings: { type: Object, required: true },
  audit: { type: Array, default: () => [] },
  demo: { type: Boolean, default: false },
  preloadBuild: { type: String, default: '' },
  storageDiag: { type: Object, default: null },
  uiBuild: { type: String, default: '' },
  authNames: { type: Array, default: () => [] }   // 已授权（有备份）的服务名
})
const emit = defineEmits(['close', 'save', 'clear-audit', 'revoke', 'revoke-all'])

const fmtTime = (ts) => new Date(ts).toLocaleString('zh-CN', { hour12: false })
const shortInput = (input) => {
  try {
    const s = JSON.stringify(input || {})
    return s.length > 48 ? s.slice(0, 48) + '…' : s
  } catch (e) { return '' }
}
const auditRows = computed(() => props.audit || [])
</script>

<template>
  <div class="modal-mask" @click.self="emit('close')">
    <div class="modal">
      <header>设置 <span class="x" @click="emit('close')">✕</span></header>
      <div class="body">
        <div style="margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid var(--border);font-size:11.5px;color:var(--sub);word-break:break-all">
          构建：界面 {{ uiBuild || 'ui-2026-09-24-c' }} · preload {{ preloadBuild || '未检测到' }}
          <template v-if="storageDiag">
            · 存储自检：{{ storageDiag.ok ? '通过' : '失败' }}
            <span v-if="storageDiag.backends">（{{ Object.entries(storageDiag.backends).map(([k, v]) => k + '=' + v).join('，') }}）</span>
          </template>
        </div>
        <div class="switch-row">
          <div class="switch" :class="{ on: settings.mcpEnabled }" @click="emit('save', { mcpEnabled: !settings.mcpEnabled })">
            <span class="track"></span><span class="knob"></span>
          </div>
          <div class="txt">
            <div class="t">AI Agent 控制（MCP）</div>
            <div class="d">开启后，Claude Code 等 AI Agent 可通过 uTools MCP 查询本插件管理的服务。默认关闭。需同时在 uTools 设置 → AI 设置 → MCP 服务 中开启。</div>
          </div>
        </div>
        <div class="switch-row" :style="{ opacity: settings.mcpEnabled ? 1 : .45 }">
          <div class="switch" :class="{ on: settings.mcpEnabled && settings.mcpWriteEnabled }" @click="settings.mcpEnabled && emit('save', { mcpWriteEnabled: !settings.mcpWriteEnabled })">
            <span class="track"></span><span class="knob"></span>
          </div>
          <div class="txt">
            <div class="t">允许 Agent 写操作</div>
            <div class="d">允许 Agent 启动/停止/重启服务、暂停/恢复、修改启动类型。关闭时 Agent 只能查询。目标服务需已在主界面完成「管理授权」。</div>
          </div>
        </div>

        <div class="section-title">
          服务管理授权（{{ authNames.length }}）
          <!-- 批量撤销走单次事件：一次 UAC + 原子更新备份库；逐个 emit 会并发跑多个 UAC 且互相覆盖备份 -->
          <span class="clear" v-if="authNames.length" @click="emit('revoke-all')">全部撤销</span>
        </div>
        <div class="auth-list" v-if="authNames.length">
          <div v-for="n in authNames" :key="n" class="auth-item">
            <span>{{ n }}</span>
            <span class="revoke" @click="emit('revoke', n)">撤销</span>
          </div>
        </div>
        <div class="audit-empty" v-else>暂无授权记录（以管理员身份运行 uTools 时无需授权）</div>
        <div class="auth-note">授权把当前用户加入服务的访问控制（可启动/停止/修改启动类型），原安全描述符已备份，可随时撤销；服务重装或系统重置后授权会失效，需重新授权。</div>

        <div class="section-title">
          工具调用审计（最近 50 条）
          <span class="clear" v-if="auditRows.length" @click="emit('clear-audit')">清空</span>
        </div>
        <table class="audit-table" v-if="auditRows.length">
          <thead>
            <tr><th style="width:130px">时间</th><th>工具</th><th>入参</th><th style="width:64px">结果</th></tr>
          </thead>
          <tbody>
            <tr v-for="(a, i) in auditRows" :key="i">
              <td>{{ fmtTime(a.ts) }}</td>
              <td>{{ a.tool }}</td>
              <td>{{ shortInput(a.input) }}</td>
              <td><span class="tag" :class="a.ok ? 'st-Running' : 'st-Unknown'">{{ a.ok ? '成功' : '失败' }}</span></td>
            </tr>
          </tbody>
        </table>
        <div class="audit-empty" v-else>暂无调用记录</div>

        <div v-if="demo" style="margin-top:10px;font-size:12px;color:var(--amber)">当前为浏览器演示模式，设置不生效于真实服务。</div>
      </div>
    </div>
  </div>
</template>
