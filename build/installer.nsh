!macro FrkbDeleteMenusForCurrentSid
  DeleteRegKey HKU "$R9\\Software\\Classes\\*\\shell\\PlayWithFRKB"
  DeleteRegKey HKU "$R9\\Software\\Classes\\SystemFileAssociations\\.mp3\\shell\\PlayWithFRKB"
  DeleteRegKey HKU "$R9\\Software\\Classes\\SystemFileAssociations\\.wav\\shell\\PlayWithFRKB"
  DeleteRegKey HKU "$R9\\Software\\Classes\\SystemFileAssociations\\.flac\\shell\\PlayWithFRKB"
  DeleteRegKey HKU "$R9\\Software\\Classes\\SystemFileAssociations\\.aif\\shell\\PlayWithFRKB"
  DeleteRegKey HKU "$R9\\Software\\Classes\\SystemFileAssociations\\.aiff\\shell\\PlayWithFRKB"
  DeleteRegKey HKU "$R9\\Software\\Classes\\SystemFileAssociations\\.ogg\\shell\\PlayWithFRKB"
  DeleteRegKey HKU "$R9\\Software\\Classes\\SystemFileAssociations\\.opus\\shell\\PlayWithFRKB"
  DeleteRegKey HKU "$R9\\Software\\Classes\\SystemFileAssociations\\.aac\\shell\\PlayWithFRKB"
  DeleteRegKey HKU "$R9\\Software\\Classes\\SystemFileAssociations\\.m4a\\shell\\PlayWithFRKB"
  DeleteRegKey HKU "$R9\\Software\\Classes\\SystemFileAssociations\\.mp4\\shell\\PlayWithFRKB"
  DeleteRegKey HKU "$R9\\Software\\Classes\\SystemFileAssociations\\.wma\\shell\\PlayWithFRKB"
  DeleteRegKey HKU "$R9\\Software\\Classes\\SystemFileAssociations\\.ac3\\shell\\PlayWithFRKB"
  DeleteRegKey HKU "$R9\\Software\\Classes\\SystemFileAssociations\\.dts\\shell\\PlayWithFRKB"
  DeleteRegKey HKU "$R9\\Software\\Classes\\SystemFileAssociations\\.mka\\shell\\PlayWithFRKB"
  DeleteRegKey HKU "$R9\\Software\\Classes\\SystemFileAssociations\\.webm\\shell\\PlayWithFRKB"
  DeleteRegKey HKU "$R9\\Software\\Classes\\SystemFileAssociations\\.ape\\shell\\PlayWithFRKB"
  DeleteRegKey HKU "$R9\\Software\\Classes\\SystemFileAssociations\\.tak\\shell\\PlayWithFRKB"
  DeleteRegKey HKU "$R9\\Software\\Classes\\SystemFileAssociations\\.tta\\shell\\PlayWithFRKB"
  DeleteRegKey HKU "$R9\\Software\\Classes\\SystemFileAssociations\\.wv\\shell\\PlayWithFRKB"
!macroend

!macro FrkbDeleteMenusAllUsers
  Push $R8
  Push $R9
  StrCpy $R8 0
loop_users:
  EnumRegKey $R9 HKU "" $R8
  StrCmp $R9 "" done_users
  ${FrkbDeleteMenusForCurrentSid}
  IntOp $R8 $R8 + 1
  Goto loop_users
done_users:
  Pop $R9
  Pop $R8
!macroend

!macro customUnInstall
  StrCpy $R9 "Software\\Classes"
  DeleteRegKey HKCU "$R9\\*\\shell\\PlayWithFRKB"
  DeleteRegKey HKCU "$R9\\SystemFileAssociations\\.mp3\\shell\\PlayWithFRKB"
  DeleteRegKey HKCU "$R9\\SystemFileAssociations\\.wav\\shell\\PlayWithFRKB"
  DeleteRegKey HKCU "$R9\\SystemFileAssociations\\.flac\\shell\\PlayWithFRKB"
  DeleteRegKey HKCU "$R9\\SystemFileAssociations\\.aif\\shell\\PlayWithFRKB"
  DeleteRegKey HKCU "$R9\\SystemFileAssociations\\.aiff\\shell\\PlayWithFRKB"
  DeleteRegKey HKCU "$R9\\SystemFileAssociations\\.ogg\\shell\\PlayWithFRKB"
  DeleteRegKey HKCU "$R9\\SystemFileAssociations\\.opus\\shell\\PlayWithFRKB"
  DeleteRegKey HKCU "$R9\\SystemFileAssociations\\.aac\\shell\\PlayWithFRKB"
  DeleteRegKey HKCU "$R9\\SystemFileAssociations\\.m4a\\shell\\PlayWithFRKB"
  DeleteRegKey HKCU "$R9\\SystemFileAssociations\\.mp4\\shell\\PlayWithFRKB"
  DeleteRegKey HKCU "$R9\\SystemFileAssociations\\.wma\\shell\\PlayWithFRKB"
  DeleteRegKey HKCU "$R9\\SystemFileAssociations\\.ac3\\shell\\PlayWithFRKB"
  DeleteRegKey HKCU "$R9\\SystemFileAssociations\\.dts\\shell\\PlayWithFRKB"
  DeleteRegKey HKCU "$R9\\SystemFileAssociations\\.mka\\shell\\PlayWithFRKB"
  DeleteRegKey HKCU "$R9\\SystemFileAssociations\\.webm\\shell\\PlayWithFRKB"
  DeleteRegKey HKCU "$R9\\SystemFileAssociations\\.ape\\shell\\PlayWithFRKB"
  DeleteRegKey HKCU "$R9\\SystemFileAssociations\\.tak\\shell\\PlayWithFRKB"
  DeleteRegKey HKCU "$R9\\SystemFileAssociations\\.tta\\shell\\PlayWithFRKB"
  DeleteRegKey HKCU "$R9\\SystemFileAssociations\\.wv\\shell\\PlayWithFRKB"
  ${FrkbDeleteMenusAllUsers}
!macroend
