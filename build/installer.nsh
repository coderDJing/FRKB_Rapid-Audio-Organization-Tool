!macro FrkbDeleteMenusForRoot ROOT BASE
  DeleteRegKey ${ROOT} "${BASE}\\*\\shell\\PlayWithFRKB"
  DeleteRegKey ${ROOT} "${BASE}\\SystemFileAssociations\\.mp3\\shell\\PlayWithFRKB"
  DeleteRegKey ${ROOT} "${BASE}\\SystemFileAssociations\\.wav\\shell\\PlayWithFRKB"
  DeleteRegKey ${ROOT} "${BASE}\\SystemFileAssociations\\.flac\\shell\\PlayWithFRKB"
  DeleteRegKey ${ROOT} "${BASE}\\SystemFileAssociations\\.aif\\shell\\PlayWithFRKB"
  DeleteRegKey ${ROOT} "${BASE}\\SystemFileAssociations\\.aiff\\shell\\PlayWithFRKB"
  DeleteRegKey ${ROOT} "${BASE}\\SystemFileAssociations\\.ogg\\shell\\PlayWithFRKB"
  DeleteRegKey ${ROOT} "${BASE}\\SystemFileAssociations\\.opus\\shell\\PlayWithFRKB"
  DeleteRegKey ${ROOT} "${BASE}\\SystemFileAssociations\\.aac\\shell\\PlayWithFRKB"
  DeleteRegKey ${ROOT} "${BASE}\\SystemFileAssociations\\.m4a\\shell\\PlayWithFRKB"
  DeleteRegKey ${ROOT} "${BASE}\\SystemFileAssociations\\.mp4\\shell\\PlayWithFRKB"
  DeleteRegKey ${ROOT} "${BASE}\\SystemFileAssociations\\.wma\\shell\\PlayWithFRKB"
  DeleteRegKey ${ROOT} "${BASE}\\SystemFileAssociations\\.ac3\\shell\\PlayWithFRKB"
  DeleteRegKey ${ROOT} "${BASE}\\SystemFileAssociations\\.dts\\shell\\PlayWithFRKB"
  DeleteRegKey ${ROOT} "${BASE}\\SystemFileAssociations\\.mka\\shell\\PlayWithFRKB"
  DeleteRegKey ${ROOT} "${BASE}\\SystemFileAssociations\\.webm\\shell\\PlayWithFRKB"
  DeleteRegKey ${ROOT} "${BASE}\\SystemFileAssociations\\.ape\\shell\\PlayWithFRKB"
  DeleteRegKey ${ROOT} "${BASE}\\SystemFileAssociations\\.tak\\shell\\PlayWithFRKB"
  DeleteRegKey ${ROOT} "${BASE}\\SystemFileAssociations\\.tta\\shell\\PlayWithFRKB"
  DeleteRegKey ${ROOT} "${BASE}\\SystemFileAssociations\\.wv\\shell\\PlayWithFRKB"
!macroend

!macro FrkbDeleteMenusAllUsers
  Push $0
  Push $1
  StrCpy $1 0
loop_users:
  EnumRegKey $0 HKU "" $1
  StrCmp $0 "" done_users
  !insertmacro FrkbDeleteMenusForRoot HKU "$0\\Software\\Classes"
  IntOp $1 $1 + 1
  Goto loop_users
done_users:
  Pop $1
  Pop $0
!macroend

!macro customUnInstall
  !insertmacro FrkbDeleteMenusForRoot HKCU "Software\\Classes"
  !insertmacro FrkbDeleteMenusAllUsers
!macroend
