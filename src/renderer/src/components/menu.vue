<script setup lang="ts">
import { watch, ref, PropType, onMounted, onUnmounted } from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { v4 as uuidV4 } from 'uuid'
import { t } from '@renderer/utils/translate'
import hotkeys from 'hotkeys-js'
import utils from '../utils/utils'
const uuid = uuidV4()
const runtime = useRuntimeStore()

type MenuButton = {
  name: string
  shortcutKey?: string
  i18nParams?: Record<string, unknown>
  action?: string
  checked?: boolean
}

const emits = defineEmits(['menuButtonClick', 'update:modelValue', 'switchMenu'])
watch(
  () => runtime.activeMenuUUID,
  (val) => {
    if (val !== uuid) {
      emits('update:modelValue', false)
    }
  }
)
const props = defineProps({
  menuArr: {
    // 支持 i18n 参数与动作标识
    type: Array as PropType<MenuButton[][]>,
    required: true
  },
  modelValue: {
    type: Boolean,
    required: true
  },
  menuName: {
    type: String
  }
})
const menuRef = ref<HTMLDivElement | null>(null)
watch(
  () => props.modelValue,
  () => {
    if (props.modelValue == true) {
      selectedMenuButton.value = ''
      utils.setHotkeysScpoe(uuid)
      runtime.activeMenuUUID = uuid
      hotkeys('w', uuid, () => {
        let menuArr = props.menuArr.flat(1)
        if (selectedMenuButton.value === '') {
          selectedMenuButton.value = getButtonKey(menuArr[menuArr.length - 1])
          return
        }
        let index = menuArr.findIndex((item) => getButtonKey(item) === selectedMenuButton.value)
        if (index === 0) {
          selectedMenuButton.value = getButtonKey(menuArr[menuArr.length - 1])
        } else {
          selectedMenuButton.value = getButtonKey(menuArr[index - 1])
        }
      })
      hotkeys('s', uuid, () => {
        let menuArr = props.menuArr.flat(1)
        if (selectedMenuButton.value === '') {
          selectedMenuButton.value = getButtonKey(menuArr[0])
          return
        }
        let index = menuArr.findIndex((item) => getButtonKey(item) === selectedMenuButton.value)
        if (index === menuArr.length - 1) {
          selectedMenuButton.value = getButtonKey(menuArr[0])
        } else {
          selectedMenuButton.value = getButtonKey(menuArr[index + 1])
        }
      })
      hotkeys('e,enter', uuid, () => {
        if (selectedMenuButton.value === '') {
          return
        }
        let menuArr = props.menuArr.flat(1)
        for (let button of menuArr) {
          if (getButtonKey(button) === selectedMenuButton.value) {
            menuButtonClick(button)
            break
          }
        }
      })
      hotkeys('q', uuid, () => {
        emits('update:modelValue', false)
      })
      hotkeys('d', uuid, () => {
        emits('switchMenu', 'next', props.menuName)
      })
      hotkeys('a', uuid, () => {
        emits('switchMenu', 'prev', props.menuName)
      })
    } else {
      selectedMenuButton.value = ''
      utils.delHotkeysScope(uuid)
    }
  }
)

const closeMenu = () => {
  if (!props.modelValue) return
  runtime.activeMenuUUID = ''
  emits('update:modelValue', false)
}

const handleGlobalPointerDown = (event: MouseEvent) => {
  if (!props.modelValue) return
  const target = event.target as Node | null
  if (!menuRef.value || (target && menuRef.value.contains(target))) return
  closeMenu()
}

onMounted(() => {
  window.addEventListener('pointerdown', handleGlobalPointerDown, true)
})

onUnmounted(() => {
  window.removeEventListener('pointerdown', handleGlobalPointerDown, true)
})

const menuButtonClick = (item: {
  name: string
  shortcutKey?: string
  action?: string
  checked?: boolean
}) => {
  runtime.activeMenuUUID = ''
  emits('menuButtonClick', item)
}
const selectedMenuButton = ref('')
const groupHasCheckmark = (
  group: Array<{ checked?: boolean; name: string; shortcutKey?: string; action?: string }>
) => group.some((button) => typeof button.checked === 'boolean')

// 生成菜单项唯一键，避免同名项同时高亮
function getButtonKey(button: {
  name: string
  shortcutKey?: string
  action?: string
  checked?: boolean
}) {
  return `${button.name}|${button.shortcutKey || ''}|${button.action || ''}`
}
</script>
<template>
  <div v-if="props.modelValue" ref="menuRef" class="menu" @click.stop="() => {}">
    <div
      v-for="item of props.menuArr"
      class="menuGroup"
      @mouseleave="
        () => {
          selectedMenuButton = ''
        }
      "
    >
      <div
        v-for="button of item"
        class="menuButton"
        :class="{ menuButtonHover: selectedMenuButton === getButtonKey(button) }"
        @click="menuButtonClick(button)"
        @mouseenter="
          () => {
            selectedMenuButton = getButtonKey(button)
          }
        "
        @contextmenu="menuButtonClick(button)"
      >
        <span class="menuButtonLabel">
          {{
            t(
              button.name,
              typeof button.i18nParams?.libraryTypeKey === 'string'
                ? { libraryType: t(button.i18nParams.libraryTypeKey) }
                : button.i18nParams
            )
          }}
        </span>
        <span class="menuButtonTail">
          <span class="menuButtonShortcut">{{ button.shortcutKey }}</span>
          <span v-if="groupHasCheckmark(item)" class="menuButtonCheck">
            {{ button.checked ? '✓' : '' }}
          </span>
        </span>
      </div>
    </div>
  </div>
</template>
<style lang="scss" scoped>
.menu {
  position: absolute;
  z-index: 10120;
  background-color: var(--bg-elev);
  border: 1px solid var(--border);
  font-size: 14px;
  width: 310px;
  border-radius: 5px;

  .menuGroup {
    border-bottom: 1px solid var(--border);
    padding: 5px 5px;

    .menuButton {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 5px 20px;
      border-radius: 5px;
    }

    .menuButtonLabel {
      display: inline-block;
      min-width: 0;
      flex: 1 1 auto;
    }

    .menuButtonTail {
      display: inline-flex;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
      margin-left: 12px;
      flex: 0 0 auto;
      min-width: 24px;
    }

    .menuButtonShortcut {
      color: inherit;
    }

    .menuButtonCheck {
      display: inline-flex;
      justify-content: center;
      align-items: center;
      width: 14px;
      font-size: 13px;
      line-height: 1;
      flex-shrink: 0;
      color: var(--accent);
    }

    .menuButtonHover .menuButtonCheck {
      color: inherit;
    }

    .menuButtonHover {
      background-color: var(--accent);
      color: #ffffff;
    }
  }

  .menuGroup:last-child {
    border-bottom: 0px;
  }
}
</style>
