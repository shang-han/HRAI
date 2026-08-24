/**
 * 输入框填充中转：当 InputArea 未挂载（如停留在模板管理页）时，
 * 填充请求先缓存，InputArea 挂载后消费，避免事件丢失。
 */
let pending: string | null = null

export function requestFillInput(text: string): void {
  pending = text
  window.dispatchEvent(new CustomEvent('fillInput', { detail: text }))
}

export function consumePendingFill(): string | null {
  const v = pending
  pending = null
  return v
}
