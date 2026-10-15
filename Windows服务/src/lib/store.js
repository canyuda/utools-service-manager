// 渲染进程侧持久化：统一走 preload 异步接口（utools.db.promises 单后端，不阻塞 UI 线程），
// 浏览器演示模式自动落到 backend.js 的 demo 后端（localStorage）。
// v1.0.5 整改：旧版四层后端全写+写后读回验证，每次进入插件 ~30 个同步 db/dbStorage
// 调用是上架审核"连带 uTools 一起卡死"的主要根源（详见 preload/services.js 存储段注释）。
import { svc } from './backend.js'

export const BUILD = 'ui-2026-10-15-a'

// 写入前深拷贝成纯对象：调用方传入的可能是 Vue reactive Proxy，跨进程序列化会失败
const plain = (v) => JSON.parse(JSON.stringify(v))

export async function getWhitelist () {
  return await svc.getWhitelist()
}

export async function saveWhitelist (list) {
  const ok = await svc.saveWhitelist(plain(list))
  return { ok: !!ok, errors: ok ? [] : ['写入失败，详见插件控制台 [svc] 日志'] }
}

export async function getSettings () {
  return await svc.getSettings()
}

export async function saveSettings (patch) {
  return await svc.saveSettings(patch)
}

export async function getAudit () {
  return await svc.getAudit()
}

export async function clearAudit () {
  return await svc.clearAudit()
}

// 存储自检：手动触发（设置页），验证 db 异步写读删 + 审计文件落盘
export async function storageSelfTest () {
  return await svc.storageSelfTest()
}
