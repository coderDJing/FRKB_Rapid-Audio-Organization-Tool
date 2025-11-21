!define FRKB_CTX_EXTS ".mp3" ".wav" ".flac" ".aif" ".aiff" ".ogg" ".opus" ".aac" ".m4a" ".mp4" ".wma" ".ac3" ".dts" ".mka" ".webm" ".ape" ".tak" ".tta" ".wv"

!macro FrkbDeleteMenusForRoot ROOT
  DeleteRegKey ${ROOT} "Software\\Classes\\*\\shell\\PlayWithFRKB"
  DeleteRegKey ${ROOT} "Software\\Classes\\SystemFileAssociations\\.mp3\\shell\\PlayWithFRKB"
  DeleteRegKey ${ROOT} "Software\\Classes\\SystemFileAssociations\\.wav\\shell\\PlayWithFRKB"
  DeleteRegKey ${ROOT} "Software\\Classes\\SystemFileAssociations\\.flac\\shell\\PlayWithFRKB"
  DeleteRegKey ${ROOT} "Software\\Classes\\SystemFileAssociations\\.aif\\shell\\PlayWithFRKB"
  DeleteRegKey ${ROOT} "Software\\Classes\\SystemFileAssociations\\.aiff\\shell\\PlayWithFRKB"
  DeleteRegKey ${ROOT} "Software\\Classes\\SystemFileAssociations\\.ogg\\shell\\PlayWithFRKB"
  DeleteRegKey ${ROOT} "Software\\Classes\\SystemFileAssociations\\.opus\\shell\\PlayWithFRKB"
  DeleteRegKey ${ROOT} "Software\\Classes\\SystemFileAssociations\\.aac\\shell\\PlayWithFRKB"
  DeleteRegKey ${ROOT} "Software\\Classes\\SystemFileAssociations\\.m4a\\shell\\PlayWithFRKB"
  DeleteRegKey ${ROOT} "Software\\Classes\\SystemFileAssociations\\.mp4\\shell\\PlayWithFRKB"
  DeleteRegKey ${ROOT} "Software\\Classes\\SystemFileAssociations\\.wma\\shell\\PlayWithFRKB"
  DeleteRegKey ${ROOT} "Software\\Classes\\SystemFileAssociations\\.ac3\\shell\\PlayWithFRKB"
  DeleteRegKey ${ROOT} "Software\\Classes\\SystemFileAssociations\\.dts\\shell\\PlayWithFRKB"
  DeleteRegKey ${ROOT} "Software\\Classes\\SystemFileAssociations\\.mka\\shell\\PlayWithFRKB"
  DeleteRegKey ${ROOT} "Software\\Classes\\SystemFileAssociations\\.webm\\shell\\PlayWithFRKB"
  DeleteRegKey ${ROOT} "Software\\Classes\\SystemFileAssociations\\.ape\\shell\\PlayWithFRKB"
  DeleteRegKey ${ROOT} "Software\\Classes\\SystemFileAssociations\\.tak\\shell\\PlayWithFRKB"
  DeleteRegKey ${ROOT} "Software\\Classes\\SystemFileAssociations\\.tta\\shell\\PlayWithFRKB"
  DeleteRegKey ${ROOT} "Software\\Classes\\SystemFileAssociations\\.wv\\shell\\PlayWithFRKB"
!macroend

!macro FrkbDeleteMenusAllUsers
  Push $0
  Push $1
  StrCpy $1 0
loop_users:
  EnumRegKey $0 HKU "" $1
  StrCmp $0 "" done_users
  ${FrkbDeleteMenusForRoot} HKU\\$0
  IntOp $1 $1 + 1
  Goto loop_users
done_users:
  Pop $1
  Pop $0
!macroend

!macro customUnInstall
  ${FrkbDeleteMenusForRoot} HKCU
  ${FrkbDeleteMenusAllUsers}
!macroend
