let mutationLocked = false

export const isLibraryMergeMutationLocked = (): boolean => mutationLocked

export const setLibraryMergeMutationLocked = (locked: boolean): void => {
  mutationLocked = locked
}
