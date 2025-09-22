import { ref } from 'vue'
import { ISongInfo } from '../../../../../../types/globals' // Corrected path

export function useCoverLoader() {
  const coverLoadTaskId = ref(0)
  const coversLoadCompleted = ref(false)

  /**
   * Increments the cover load task ID, effectively cancelling any ongoing previous tasks,
   * and resets the completion status.
   */
  const startNewCoverLoadSession = () => {
    coverLoadTaskId.value++
    coversLoadCompleted.value = false
    return coverLoadTaskId.value // Return the new task ID
  }

  /**
   * Processes covers in batches using requestAnimationFrame.
   * @param data - Array of song information.
   * @param currentTaskId - The task ID for this loading session.
   * @param batchSize - Number of covers to process per batch.
   * @returns Promise<boolean> - True if completed fully, false if cancelled.
   */
  async function loadCoversInBatches(
    data: ISongInfo[],
    currentTaskId: number,
    batchSize = 1
  ): Promise<boolean> {
    if (coverLoadTaskId.value !== currentTaskId) {
      return false // Cancelled
    }

    for (let i = 0; i < data.length; i += batchSize) {
      if (coverLoadTaskId.value !== currentTaskId) {
        return false // Cancelled
      }

      // 列表中不再显示封面，跳过封面处理

      await new Promise((resolve) => requestAnimationFrame(resolve))

      if (coverLoadTaskId.value !== currentTaskId) {
        return false // Cancelled
      }
    }
    coversLoadCompleted.value = true // Mark as completed only if this task finished fully
    return true // Fully completed
  }

  return {
    coverLoadTaskId, // Expose for read-only purposes if needed, or specific scenarios
    coversLoadCompleted, // Expose for components to react to completion status
    startNewCoverLoadSession,
    loadCoversInBatches
  }
}
