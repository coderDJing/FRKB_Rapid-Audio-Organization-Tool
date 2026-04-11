import type { AppContext, VNode } from 'vue'

type FrkbWindow = Window & {
  __FRKB_APP_CONTEXT__?: AppContext
}

export const attachAppContext = <T extends VNode>(vnode: T): T => {
  const context = (window as FrkbWindow).__FRKB_APP_CONTEXT__
  if (context) vnode.appContext = context
  return vnode
}
