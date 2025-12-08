<script setup lang="ts">
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import { t } from '@renderer/utils/translate'
import { useCustomFileSelector } from './useCustomFileSelector'
import type { CustomFileSelectorEmits, CustomFileSelectorProps } from './types'

const props = withDefaults(defineProps<CustomFileSelectorProps>(), {
  visible: false,
  multiSelect: true,
  allowMixedSelection: true,
  initialSelectedPaths: () => []
})
const emit = defineEmits<CustomFileSelectorEmits>()

const {
  visible,
  currentPath,
  selectedItems,
  searchQuery,
  searchInputRef,
  isLoading,
  filteredTree,
  selectedCount,
  selectedFilesCount,
  selectedFoldersCount,
  scrollbarOptions,
  handleItemClick,
  handleItemDoubleClick,
  removeSelectionByPath,
  clearSelection,
  confirm,
  cancel,
  modalRef,
  fileListRef,
  selectedListRef,
  formatFileSize,
  getItemIcon,
  navigateUp,
  findItemIndex,
  isDrive
} = useCustomFileSelector(props, emit)
</script>

<template>
  <div v-if="visible" class="file-selector-modal" ref="modalRef" tabindex="0">
    <div class="file-selector-content">
      <!-- 顶部路径导航 -->
      <div class="path-navigation">
        <div class="path-breadcrumb">
          <button class="back-button" type="button" @click="navigateUp" :disabled="!currentPath">
            {{ t('fileSelector.navigateUp') }}
          </button>
          <span class="path-current" :title="currentPath" v-if="currentPath">{{
            currentPath
          }}</span>
          <span class="path-current" v-else>{{ t('fileSelector.rootLabel') }}</span>
        </div>
        <div class="path-search">
          <input
            ref="searchInputRef"
            v-model="searchQuery"
            type="text"
            :placeholder="t('fileSelector.searchPlaceholder')"
            class="search-input"
          />
        </div>
      </div>

      <!-- 主要内容区域 -->
      <div class="main-content">
        <!-- 文件列表 -->
        <div class="file-list-container">
          <div class="file-list-header">
            <span class="header-name">{{ t('fileSelector.name') }}</span>
            <span class="header-size">{{ t('fileSelector.size') }}</span>
            <span class="header-type">{{ t('fileSelector.type') }}</span>
          </div>

          <div v-if="isLoading" class="loading-state">
            <div class="loading-spinner"></div>
            <span>{{ t('fileSelector.loading') }}</span>
          </div>

          <OverlayScrollbarsComponent
            v-else
            :options="scrollbarOptions"
            element="div"
            class="file-list"
            defer
          >
            <div v-for="(item, index) in filteredTree" :key="item.path" class="file-item-wrapper">
              <div
                class="file-item"
                :class="{
                  'is-directory': item.type === 'directory',
                  'is-file': item.type === 'file',
                  'is-selected': item.isSelected
                }"
                :data-index="findItemIndex(item)"
                :data-path="item.path"
                @click="handleItemClick(item, $event)"
                @dblclick="item.type === 'directory' ? handleItemDoubleClick(item, $event) : null"
              >
                <div class="item-icon">
                  <img :src="getItemIcon(item)" alt="" />
                </div>
                <div class="item-name-wrapper">
                  <div class="item-name" :title="item.name">{{ item.name }}</div>
                </div>
                <div class="item-size" v-if="item.size && item.size > 0">
                  {{ formatFileSize(item.size) }}
                </div>
                <div class="item-size" v-else-if="item.type === 'directory'">-</div>
                <div class="item-size" v-else>{{ formatFileSize(item.size || 0) }}</div>
                <div class="item-type" v-if="item.type === 'file'">
                  {{ item.name.split('.').pop()?.toUpperCase() }}
                </div>
                <div class="item-type" v-else-if="item.type === 'directory'">
                  {{
                    (item as any).isSpecial
                      ? '常用文件夹'
                      : isDrive(item)
                        ? '驱动器'
                        : t('fileSelector.folder')
                  }}
                </div>
              </div>
            </div>
          </OverlayScrollbarsComponent>
        </div>

        <!-- 选中项目面板 -->
        <div class="selected-panel">
          <div class="selected-header">
            <h4 class="selected-title">
              {{ t('fileSelector.selectedItems') }}
              <span class="selected-count">({{ selectedCount }})</span>
            </h4>
            <button @click="clearSelection" class="clear-btn" :disabled="selectedCount === 0">
              {{ t('fileSelector.clearAll') }}
            </button>
          </div>

          <div class="selected-stats">
            <span v-if="selectedFilesCount > 0" class="stat-item">
              {{ t('fileSelector.filesSelected', { count: selectedFilesCount }) }}
            </span>
            <span v-if="selectedFoldersCount > 0" class="stat-item">
              {{ t('fileSelector.foldersSelected', { count: selectedFoldersCount }) }}
            </span>
          </div>

          <OverlayScrollbarsComponent
            v-if="selectedCount > 0"
            :options="scrollbarOptions"
            element="div"
            class="selected-list"
            ref="selectedListRef"
            defer
          >
            <div v-for="item in selectedItems" :key="item.id" class="selected-item">
              <div class="selected-icon">
                <img :src="getItemIcon(item as any)" alt="" />
              </div>
              <div class="selected-info">
                <div class="selected-name" :title="item.name">{{ item.name }}</div>
                <div class="selected-path" :title="item.path">{{ item.path }}</div>
              </div>
              <button @click="removeSelectionByPath(item.path)" class="remove-btn">×</button>
            </div>
          </OverlayScrollbarsComponent>

          <div v-else class="empty-selection">
            {{ t('fileSelector.noSelection') }}
          </div>
        </div>
      </div>

      <!-- 底部操作区 -->
      <div class="action-bar">
        <div class="action-buttons import-dialog-style">
          <div
            class="button"
            style="margin-right: 10px; width: 90px; text-align: center"
            @click="confirm"
          >
            {{ t('common.confirm') }} (E)
          </div>
          <div class="button" @click="cancel" style="width: 90px; text-align: center">
            {{ t('common.cancel') }} (Esc)
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.file-selector-modal {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 700px;
  height: 450px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
  display: flex;
  flex-direction: column;
  z-index: 10050; // 高于全局 .dialog(9999)
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  user-select: none;
  -webkit-user-select: none;
  color: var(--text); // 与导入对话框文字颜色一致
}

.file-selector-content {
  display: flex;
  flex-direction: column;
  height: 100%;
}

/* 路径导航 */
.path-navigation {
  padding: 10px 12px;
  background: var(--bg-elev);
  border-bottom: 1px solid var(--border);
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;

  .path-breadcrumb {
    display: flex;
    align-items: center;
    flex: 1 1 auto;
    min-width: 0; // 允许内容收缩，避免把右侧搜索框挤出
    font-size: 12px;
    color: var(--text);
    gap: 8px;

    .back-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 4px 8px;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: var(--bg-elev);
      color: var(--text);
      font-size: 12px;
      cursor: pointer;
      transition:
        background-color 0.2s,
        border-color 0.2s;
      min-width: 80px;

      &:hover:not(:disabled) {
        background: var(--hover);
        border-color: var(--accent);
        color: #ffffff;
      }

      &:disabled {
        cursor: not-allowed;
        background: var(--bg);
        color: var(--text-weak);
        border-color: var(--border);
      }
    }

    .path-current {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  }

  .path-search {
    flex: 0 0 auto; // 固定宽度区域，不随父容器收缩
    flex-shrink: 0;
    .search-input {
      width: 160px;
      height: 25px;
      padding: 0 8px;
      border: 1px solid var(--border);
      border-radius: 4px;
      font-size: 12px;
      background: var(--bg-elev);
      color: var(--text);

      &:focus {
        outline: none;
        border-color: var(--accent);
        box-shadow: 0 0 0 2px rgba(0, 120, 212, 0.25);
      }

      &::placeholder {
        color: var(--text-weak);
      }
    }
  }
}

/* 主要内容区域 */
.main-content {
  flex: 1;
  display: flex;
  min-height: 0;
  height: 100%;
}

/* 文件列表 */
.file-list-container {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  min-width: 0; /* 防止flex项目溢出 */
  width: 0; /* 确保flex项目占用剩余空间 */

  .file-list-header {
    display: flex;
    padding: 6px 12px;
    background: var(--bg-elev);
    border-bottom: 1px solid var(--border);
    font-size: 11px;
    font-weight: 500;
    color: var(--text-weak);
    text-transform: uppercase;

    span {
      flex: 1;
      min-width: 0;

      &:first-child {
        flex: 1;
        min-width: 200px; // 文件名列最小宽度
      }

      &:nth-child(2) {
        flex: 0 0 80px;
        text-align: right;
        min-width: 80px;
      }

      &:nth-child(3) {
        flex: 0 0 80px;
        text-align: right;
        min-width: 80px;
      }
    }
  }

  .loading-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    flex: 1;
    color: var(--text-weak);
    font-size: 14px;

    .loading-spinner {
      width: 32px;
      height: 32px;
      border: 3px solid var(--hover);
      border-top: 3px solid var(--accent);
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin-bottom: 12px;
    }
  }

  .file-list {
    flex: 1;
    height: 100%;
    padding: 2px 0;
    overflow: hidden;

    .file-item-wrapper {
      width: 100%;
    }

    .file-item {
      display: flex;
      align-items: center;
      padding: 4px 12px;
      cursor: default;
      border-bottom: 1px solid var(--border);
      transition: background-color 0.2s;

      &:hover {
        background-color: var(--hover);
      }

      &.is-selected {
        background-color: var(--hover);
        border-color: var(--accent);
      }

      .item-icon {
        flex: 0 0 18px;
        text-align: center;
        margin-right: 8px;
        font-size: 14px;

        img {
          width: 18px;
          height: 18px;
          object-fit: contain;
          display: block;
          filter: brightness(0.85);
        }
      }

      .item-name-wrapper {
        flex: 1;
        min-width: 200px;
        max-width: 300px;
        margin-right: 8px;
      }

      .item-name {
        font-size: 12px;
        color: var(--text);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .item-size {
        flex: 0 0 80px;
        text-align: right;
        font-size: 11px;
        color: var(--text-weak);
        min-width: 80px;
      }

      .item-type {
        flex: 0 0 80px;
        text-align: right;
        font-size: 10px;
        color: var(--text-weak);
        text-transform: uppercase;
        min-width: 80px;
      }
    }
  }
}

/* 选中项目面板 */
.selected-panel {
  width: 200px;
  background: var(--bg-elev);
  border-left: 1px solid var(--border);
  display: flex;
  flex-direction: column;

  .selected-header {
    padding: 8px 10px;
    border-bottom: 1px solid var(--border);
    display: flex;
    justify-content: space-between;
    align-items: center;

    .selected-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--text);
      margin: 0;

      .selected-count {
        color: var(--accent);
        font-weight: normal;
      }
    }

    .clear-btn {
      height: 20px;
      line-height: 20px;
      padding: 0 8px;
      border-radius: 4px;
      background-color: #dc3545;
      color: #ffffff;
      border: none;
      font-size: 11px;
      cursor: pointer;
      transition: background-color 0.2s;

      &:hover:not(:disabled) {
        background: #c82333;
      }

      &:disabled {
        background: #666666;
        cursor: not-allowed;
      }
    }
  }

  .selected-stats {
    padding: 6px 10px;
    background: var(--bg-elev);
    font-size: 11px;
    color: var(--text-weak);

    .stat-item {
      display: inline-block;
      margin-right: 8px;

      &:last-child {
        margin-right: 0;
      }
    }
  }

  .selected-list {
    flex: 1;
    height: 100%;
    padding: 6px;
    overflow: hidden;

    .selected-item {
      display: flex;
      align-items: center;
      padding: 4px 6px;
      margin-bottom: 3px;
      background: var(--bg-elev);
      border: 1px solid var(--border);
      border-radius: 3px;
      cursor: default;
      gap: 4px;

      .selected-icon {
        flex: 0 0 16px;
        text-align: center;
        margin-right: 6px;
        font-size: 12px;

        img {
          width: 16px;
          height: 16px;
          object-fit: contain;
          display: block;
          filter: brightness(0.85);
        }
      }

      .selected-info {
        flex: 1;
        min-width: 0;

        .selected-name {
          font-size: 11px;
          font-weight: 500;
          color: var(--text);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .selected-path {
          font-size: 9px;
          color: var(--text-weak);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
      }

      .remove-btn {
        flex: 0 0 auto;
        background: none;
        border: none;
        color: #dc3545;
        cursor: pointer;
        font-size: 12px;
        padding: 0;
        width: 16px;
        height: 16px;
        border-radius: 3px;
        display: flex;
        align-items: center;
        justify-content: center;

        &:hover {
          color: #ff6b81;
        }
      }
    }
  }

  .empty-selection {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-weak);
    font-size: 12px;
    font-style: italic;
  }
}

/* 操作栏 */
.action-bar {
  padding: 8px 12px;
  background: var(--bg-elev);
  border-top: 1px solid var(--border);
  display: flex;
  justify-content: center;
  align-items: center;

  .action-buttons {
    display: flex;
    gap: 8px;

    .cancel-btn {
      height: 25px;
      line-height: 25px;
      padding: 0 10px;
      border-radius: 5px;
      background-color: #2d2e2e;
      color: #cccccc;
      border: none;
      font-size: 14px;
      cursor: pointer;
      transition: all 0.2s;

      &:hover {
        color: white;
        background-color: #0078d4;
      }
    }

    .confirm-btn {
      height: 25px;
      line-height: 25px;
      padding: 0 10px;
      border-radius: 5px;
      background-color: #2d2e2e;
      color: #cccccc;
      border: none;
      font-size: 14px;
      cursor: pointer;
      transition: all 0.2s;

      &:hover:not(:disabled) {
        color: white;
        background-color: #0078d4;
      }

      &:disabled {
        background: #666666;
        cursor: not-allowed;
        color: #999999;
      }
    }
  }
}

/* 动画 */
@keyframes spin {
  0% {
    transform: rotate(0deg);
  }
  100% {
    transform: rotate(360deg);
  }
}
</style>
