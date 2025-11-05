import type { AppContext, VNode } from 'vue'

export const attachAppContext = <T extends VNode>(vnode: T): T => {
  const context = (window as any).__FRKB_APP_CONTEXT__ as AppContext | undefined
  if (context) vnode.appContext = context
  return vnode
}
