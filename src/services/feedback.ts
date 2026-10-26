import { ref } from 'vue'

export const notice = ref('')
let timeout: ReturnType<typeof setTimeout>
export function notify(message: string) {
  notice.value = message
  clearTimeout(timeout)
  timeout = setTimeout(() => { notice.value = '' }, 5000)
}
