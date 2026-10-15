; Frameforge "approve admin once": remove the optional FrameforgeBroker service when Frameforge is uninstalled.
; The macro also runs for the silent uninstall that precedes an app update, and an update must keep the service, so it does
; nothing then (${isUpdated}). The existence check (sc query) needs no administrator rights, so the Windows prompt appears
; only when the service really exists. The helper runs with the runas verb and a fixed argument that can only remove.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    nsExec::ExecToStack '"$SYSDIR\sc.exe" query FrameforgeBroker'
    Pop $0
    ${if} $0 == 0
      ${if} ${FileExists} "$INSTDIR\resources\windows\Frameforge.Windows.exe"
        ExecShellWait "runas" "$INSTDIR\resources\windows\Frameforge.Windows.exe" "--broker-uninstall" SW_HIDE
      ${endIf}
    ${endIf}
  ${endIf}
!macroend
