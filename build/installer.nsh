; Frameforge "approve admin once": remove the optional FrameforgeBroker service when Frameforge is uninstalled.
; The macro also runs for the silent uninstall that precedes an app update, and an update must keep the service, so it does
; nothing then (${isUpdated}). The existence check (sc query) needs no administrator rights, so the Windows prompt appears
; only when the service really exists. The helper runs with the runas verb and a fixed argument that can only remove.
; ExecShellWait gives no exit code, so success is checked by asking the service manager again; a service that is still there
; (the prompt was declined, or removal failed) is reported instead of being left behind silently.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    nsExec::ExecToStack '"$SYSDIR\sc.exe" query FrameforgeBroker'
    Pop $0
    ${if} $0 == 0
      ${if} ${FileExists} "$INSTDIR\resources\windows\Frameforge.Windows.exe"
        ExecShellWait "runas" "$INSTDIR\resources\windows\Frameforge.Windows.exe" "--broker-uninstall" SW_HIDE
      ${endIf}
      nsExec::ExecToStack '"$SYSDIR\sc.exe" query FrameforgeBroker'
      Pop $0
      ${if} $0 == 0
        MessageBox MB_OK|MB_ICONEXCLAMATION "Frameforge was uninstalled, but its admin service (FrameforgeBroker) could not be removed.$\r$\n$\r$\nRemove it from an administrator command prompt with:$\r$\n  sc stop FrameforgeBroker$\r$\n  sc delete FrameforgeBroker" /SD IDOK
      ${endIf}
    ${endIf}
  ${endIf}
!macroend
