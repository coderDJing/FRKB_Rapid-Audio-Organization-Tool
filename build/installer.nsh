; 卸载时清理运行时写入的右键菜单（PlayWithFRKB）
; 不再依赖硬编码扩展名列表，改为遍历 SystemFileAssociations 下的全部扩展名，
; 这样用户在设置里自定义添加的格式（默认列表之外）也能被清理干净。
;
; 注意：DeleteRegKey / EnumRegKey 的根键（HKCU/HKU）必须是编译期字面量，
; 不能使用变量。宏是文本替换，因此把根键作为宏参数传入是安全的。
; UNIQ 参数用于在宏被多次展开时保证跳转标签唯一，避免重复定义。
!macro FrkbDeleteMenusForRoot ROOT BASE UNIQ
  Push $R0
  Push $R1
  ; 旧版：针对所有文件类型的全局菜单
  DeleteRegKey ${ROOT} "${BASE}\\*\\shell\\PlayWithFRKB"
  ; 遍历 SystemFileAssociations 下的全部扩展名子键，删除各自的 PlayWithFRKB。
  ; 这里删除的是扩展名键的子键（.ext\shell\PlayWithFRKB），扩展名键本身保留，
  ; 故枚举集合在循环中不变，索引可安全递增。
  StrCpy $R1 0
frkb_loop_${UNIQ}:
  EnumRegKey $R0 ${ROOT} "${BASE}\\SystemFileAssociations" $R1
  StrCmp $R0 "" frkb_done_${UNIQ}
  DeleteRegKey ${ROOT} "${BASE}\\SystemFileAssociations\\$R0\\shell\\PlayWithFRKB"
  IntOp $R1 $R1 + 1
  Goto frkb_loop_${UNIQ}
frkb_done_${UNIQ}:
  Pop $R1
  Pop $R0
!macroend

!macro FrkbDeleteMenusAllUsers
  Push $0
  Push $1
  StrCpy $1 0
loop_users:
  EnumRegKey $0 HKU "" $1
  StrCmp $0 "" done_users
  !insertmacro FrkbDeleteMenusForRoot HKU "$0\\Software\\Classes" hku
  IntOp $1 $1 + 1
  Goto loop_users
done_users:
  Pop $1
  Pop $0
!macroend

!macro customUnInstall
  !insertmacro FrkbDeleteMenusForRoot HKCU "Software\\Classes" hkcu
  !insertmacro FrkbDeleteMenusAllUsers
!macroend
