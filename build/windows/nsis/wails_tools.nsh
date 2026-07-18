# DO NOT EDIT - Generated automatically by `wails build`

!include "x64.nsh"
!include "WinVer.nsh"
!include "FileFunc.nsh"

!ifndef INFO_PROJECTNAME
    !define INFO_PROJECTNAME "komika"
!endif
!ifndef INFO_COMPANYNAME
    !define INFO_COMPANYNAME "Komika"
!endif
!ifndef INFO_PRODUCTNAME
    !define INFO_PRODUCTNAME "Komika"
!endif
!ifndef INFO_PRODUCTVERSION
    !define INFO_PRODUCTVERSION "0.0.1"
!endif
!ifndef INFO_COPYRIGHT
    !define INFO_COPYRIGHT "(c) 2026, Komika"
!endif
!ifndef PRODUCT_EXECUTABLE
    !define PRODUCT_EXECUTABLE "${INFO_PROJECTNAME}.exe"
!endif
!ifndef UNINST_KEY_NAME
    !define UNINST_KEY_NAME "${INFO_COMPANYNAME}${INFO_PRODUCTNAME}"
!endif
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINST_KEY_NAME}"

!ifndef WAILS_INSTALL_SCOPE
    !define WAILS_INSTALL_SCOPE "machine"
!endif

!ifndef REQUEST_EXECUTION_LEVEL
    !if "${WAILS_INSTALL_SCOPE}" == "user"
        !define REQUEST_EXECUTION_LEVEL "user"
    !else
        !define REQUEST_EXECUTION_LEVEL "admin"
    !endif
!endif

RequestExecutionLevel "${REQUEST_EXECUTION_LEVEL}"

!ifdef ARG_WAILS_AMD64_BINARY
    !define SUPPORTS_AMD64
!endif

!ifdef ARG_WAILS_ARM64_BINARY
    !define SUPPORTS_ARM64
!endif

!ifdef SUPPORTS_AMD64
    !ifdef SUPPORTS_ARM64
        !define ARCH "amd64_arm64"
    !else
        !define ARCH "amd64"
    !endif
!else
    !ifdef SUPPORTS_ARM64
        !define ARCH "arm64"
    !else
        !error "Wails: Undefined ARCH, please provide at least one of ARG_WAILS_AMD64_BINARY or ARG_WAILS_ARM64_BINARY"
    !endif
!endif

!macro wails.checkArchitecture
    !ifndef WAILS_WIN10_REQUIRED
        !define WAILS_WIN10_REQUIRED "This product is only supported on Windows 10 (Server 2016) and later."
    !endif

    !ifndef WAILS_ARCHITECTURE_NOT_SUPPORTED
        !define WAILS_ARCHITECTURE_NOT_SUPPORTED "This product can't be installed on the current Windows architecture. Supports: ${ARCH}"
    !endif

    ${If} ${AtLeastWin10}
        !ifdef SUPPORTS_AMD64
            ${if} ${IsNativeAMD64}
                Goto ok
            ${EndIf}
        !endif

        !ifdef SUPPORTS_ARM64
            ${if} ${IsNativeARM64}
                Goto ok
            ${EndIf}
        !endif

        IfSilent silentArch notSilentArch
        silentArch:
            SetErrorLevel 65
            Abort
        notSilentArch:
            MessageBox MB_OK "${WAILS_ARCHITECTURE_NOT_SUPPORTED}"
            Quit
    ${else}
        IfSilent silentWin notSilentWin
        silentWin:
            SetErrorLevel 64
            Abort
        notSilentWin:
            MessageBox MB_OK "${WAILS_WIN10_REQUIRED}"
            Quit
    ${EndIf}

    ok:
!macroend

!macro wails.files
    !ifdef SUPPORTS_AMD64
        ${if} ${IsNativeAMD64}
            File "/oname=${PRODUCT_EXECUTABLE}" "${ARG_WAILS_AMD64_BINARY}"
        ${EndIf}
    !endif

    !ifdef SUPPORTS_ARM64
        ${if} ${IsNativeARM64}
            File "/oname=${PRODUCT_EXECUTABLE}" "${ARG_WAILS_ARM64_BINARY}"
        ${EndIf}
    !endif
!macroend

!macro wails.writeUninstaller
    WriteUninstaller "$INSTDIR\uninstall.exe"

    SetRegView 64
    !if "${WAILS_INSTALL_SCOPE}" == "user"
        WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "${INFO_COMPANYNAME}"
        WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${INFO_PRODUCTNAME}"
        WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${INFO_PRODUCTVERSION}"
        WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\${PRODUCT_EXECUTABLE}"
        WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
        WriteRegStr HKCU "${UNINST_KEY}" "QuietUninstallString" "$\"$INSTDIR\uninstall.exe$\" /S"

        ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
        IntFmt $0 "0x%08X" $0
        WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" "$0"
    !else
        WriteRegStr HKLM "${UNINST_KEY}" "Publisher" "${INFO_COMPANYNAME}"
        WriteRegStr HKLM "${UNINST_KEY}" "DisplayName" "${INFO_PRODUCTNAME}"
        WriteRegStr HKLM "${UNINST_KEY}" "DisplayVersion" "${INFO_PRODUCTVERSION}"
        WriteRegStr HKLM "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\${PRODUCT_EXECUTABLE}"
        WriteRegStr HKLM "${UNINST_KEY}" "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
        WriteRegStr HKLM "${UNINST_KEY}" "QuietUninstallString" "$\"$INSTDIR\uninstall.exe$\" /S"

        ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
        IntFmt $0 "0x%08X" $0
        WriteRegDWORD HKLM "${UNINST_KEY}" "EstimatedSize" "$0"
    !endif
!macroend

!macro wails.deleteUninstaller
    Delete "$INSTDIR\uninstall.exe"

    SetRegView 64
    !if "${WAILS_INSTALL_SCOPE}" == "user"
        DeleteRegKey HKCU "${UNINST_KEY}"
    !else
        DeleteRegKey HKLM "${UNINST_KEY}"
    !endif
!macroend

!macro wails.setShellContext
    ${If} ${REQUEST_EXECUTION_LEVEL} == "admin"
        SetShellVarContext all
    ${else}
        SetShellVarContext current
    ${EndIf}
!macroend

# Install webview2 by launching the bootstrapper
# See https://docs.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution#online-only-deployment
!macro wails.webview2runtime
    !ifndef WAILS_INSTALL_WEBVIEW_DETAILPRINT
        !define WAILS_INSTALL_WEBVIEW_DETAILPRINT "Installing: WebView2 Runtime"
    !endif

    SetRegView 64
	# If the admin key exists and is not empty then webview2 is already installed
	ReadRegStr $0 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
    ${If} $0 != ""
        Goto ok
    ${EndIf}

    ${If} ${REQUEST_EXECUTION_LEVEL} == "user"
        # If the installer is run in user level, check the user specific key exists and is not empty then webview2 is already installed
	    ReadRegStr $0 HKCU "Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
        ${If} $0 != ""
            Goto ok
        ${EndIf}
     ${EndIf}
    
	SetDetailsPrint both
    DetailPrint "${WAILS_INSTALL_WEBVIEW_DETAILPRINT}"
    SetDetailsPrint listonly
    
    InitPluginsDir
    CreateDirectory "$pluginsdir\webview2bootstrapper"
    SetOutPath "$pluginsdir\webview2bootstrapper"
    File "MicrosoftEdgeWebview2Setup.exe"
    ExecWait '"$pluginsdir\webview2bootstrapper\MicrosoftEdgeWebview2Setup.exe" /silent /install'
    
    SetDetailsPrint both
    ok:
!macroend

# Additive Open With only — never write Software\Classes\.<ext> default ProgID.
!macro OPENWITH_ASSOCIATE EXT PROGID DESCRIPTION ICON
  ; ProgID command — does NOT write Software\Classes\.${EXT} default value
  WriteRegStr SHELL_CONTEXT "Software\Classes\${PROGID}" "" `${DESCRIPTION}`
  WriteRegStr SHELL_CONTEXT "Software\Classes\${PROGID}\DefaultIcon" "" `${ICON}`
  WriteRegStr SHELL_CONTEXT "Software\Classes\${PROGID}\shell\open\command" "" '"$INSTDIR\${PRODUCT_EXECUTABLE}" "%1"'
  WriteRegStr SHELL_CONTEXT "Software\Classes\.${EXT}\OpenWithProgids" "${PROGID}" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${PRODUCT_EXECUTABLE}" "FriendlyAppName" "Komika"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${PRODUCT_EXECUTABLE}\SupportedTypes" ".${EXT}" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${PRODUCT_EXECUTABLE}\shell\open\command" "" '"$INSTDIR\${PRODUCT_EXECUTABLE}" "%1"'
!macroend

!macro OPENWITH_UNASSOCIATE EXT PROGID
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.${EXT}\OpenWithProgids" "${PROGID}"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\${PROGID}"
!macroend

# Legacy APP_ASSOCIATE macros kept unused so accidental inserts fail closed if reintroduced.
!macro APP_ASSOCIATE EXT FILECLASS DESCRIPTION ICON COMMANDTEXT COMMAND
  !error "APP_ASSOCIATE is disabled; use OPENWITH_ASSOCIATE (additive Open With only)"
!macroend

!macro APP_UNASSOCIATE EXT FILECLASS
  !error "APP_UNASSOCIATE is disabled; use OPENWITH_UNASSOCIATE"
!macroend

!macro wails.associateFiles
    ; Create additive Open With associations only (no default-handler takeover)
    File "..\icon.ico"
    !insertmacro OPENWITH_ASSOCIATE "cbz" "Komika.CBZ" "Comic Book Zip Archive" "$INSTDIR\icon.ico"
    !insertmacro OPENWITH_ASSOCIATE "zip" "Komika.ZIP" "ZIP Archive" "$INSTDIR\icon.ico"
    !insertmacro OPENWITH_ASSOCIATE "cbr" "Komika.CBR" "Comic Book RAR Archive" "$INSTDIR\icon.ico"
    !insertmacro OPENWITH_ASSOCIATE "rar" "Komika.RAR" "RAR Archive" "$INSTDIR\icon.ico"
    !insertmacro OPENWITH_ASSOCIATE "cb7" "Komika.CB7" "Comic Book 7z Archive" "$INSTDIR\icon.ico"
    !insertmacro OPENWITH_ASSOCIATE "7z" "Komika.7Z" "7z Archive" "$INSTDIR\icon.ico"
    !insertmacro OPENWITH_ASSOCIATE "pdf" "Komika.PDF" "PDF Document" "$INSTDIR\icon.ico"
    !insertmacro OPENWITH_ASSOCIATE "md" "Komika.MD" "Markdown Document" "$INSTDIR\icon.ico"
    !insertmacro OPENWITH_ASSOCIATE "markdown" "Komika.MARKDOWN" "Markdown Document" "$INSTDIR\icon.ico"
    !insertmacro OPENWITH_ASSOCIATE "jpg" "Komika.JPG" "JPEG Image" "$INSTDIR\icon.ico"
    !insertmacro OPENWITH_ASSOCIATE "jpeg" "Komika.JPEG" "JPEG Image" "$INSTDIR\icon.ico"
    !insertmacro OPENWITH_ASSOCIATE "png" "Komika.PNG" "PNG Image" "$INSTDIR\icon.ico"
    !insertmacro OPENWITH_ASSOCIATE "webp" "Komika.WEBP" "WebP Image" "$INSTDIR\icon.ico"
    !insertmacro OPENWITH_ASSOCIATE "gif" "Komika.GIF" "GIF Image" "$INSTDIR\icon.ico"
    !insertmacro OPENWITH_ASSOCIATE "webm" "Komika.WEBM" "WebM Video" "$INSTDIR\icon.ico"
    !insertmacro OPENWITH_ASSOCIATE "mp4" "Komika.MP4" "MP4 Video" "$INSTDIR\icon.ico"
    !insertmacro OPENWITH_ASSOCIATE "mov" "Komika.MOV" "QuickTime Video" "$INSTDIR\icon.ico"
    !insertmacro OPENWITH_ASSOCIATE "mp3" "Komika.MP3" "MP3 Audio" "$INSTDIR\icon.ico"
    !insertmacro OPENWITH_ASSOCIATE "m4a" "Komika.M4A" "M4A Audio" "$INSTDIR\icon.ico"
    !insertmacro OPENWITH_ASSOCIATE "aac" "Komika.AAC" "AAC Audio" "$INSTDIR\icon.ico"
    !insertmacro OPENWITH_ASSOCIATE "ogg" "Komika.OGG" "Ogg Audio" "$INSTDIR\icon.ico"
    !insertmacro OPENWITH_ASSOCIATE "opus" "Komika.OPUS" "Opus Audio" "$INSTDIR\icon.ico"
    !insertmacro OPENWITH_ASSOCIATE "wav" "Komika.WAV" "WAV Audio" "$INSTDIR\icon.ico"
!macroend

!macro wails.unassociateFiles
    ; Delete additive Open With associations
    !insertmacro OPENWITH_UNASSOCIATE "cbz" "Komika.CBZ"
    !insertmacro OPENWITH_UNASSOCIATE "zip" "Komika.ZIP"
    !insertmacro OPENWITH_UNASSOCIATE "cbr" "Komika.CBR"
    !insertmacro OPENWITH_UNASSOCIATE "rar" "Komika.RAR"
    !insertmacro OPENWITH_UNASSOCIATE "cb7" "Komika.CB7"
    !insertmacro OPENWITH_UNASSOCIATE "7z" "Komika.7Z"
    !insertmacro OPENWITH_UNASSOCIATE "pdf" "Komika.PDF"
    !insertmacro OPENWITH_UNASSOCIATE "md" "Komika.MD"
    !insertmacro OPENWITH_UNASSOCIATE "markdown" "Komika.MARKDOWN"
    !insertmacro OPENWITH_UNASSOCIATE "jpg" "Komika.JPG"
    !insertmacro OPENWITH_UNASSOCIATE "jpeg" "Komika.JPEG"
    !insertmacro OPENWITH_UNASSOCIATE "png" "Komika.PNG"
    !insertmacro OPENWITH_UNASSOCIATE "webp" "Komika.WEBP"
    !insertmacro OPENWITH_UNASSOCIATE "gif" "Komika.GIF"
    !insertmacro OPENWITH_UNASSOCIATE "webm" "Komika.WEBM"
    !insertmacro OPENWITH_UNASSOCIATE "mp4" "Komika.MP4"
    !insertmacro OPENWITH_UNASSOCIATE "mov" "Komika.MOV"
    !insertmacro OPENWITH_UNASSOCIATE "mp3" "Komika.MP3"
    !insertmacro OPENWITH_UNASSOCIATE "m4a" "Komika.M4A"
    !insertmacro OPENWITH_UNASSOCIATE "aac" "Komika.AAC"
    !insertmacro OPENWITH_UNASSOCIATE "ogg" "Komika.OGG"
    !insertmacro OPENWITH_UNASSOCIATE "opus" "Komika.OPUS"
    !insertmacro OPENWITH_UNASSOCIATE "wav" "Komika.WAV"
    DeleteRegKey SHELL_CONTEXT "Software\Classes\Applications\${PRODUCT_EXECUTABLE}"
    Delete "$INSTDIR\icon.ico"
!macroend

!macro CUSTOM_PROTOCOL_ASSOCIATE PROTOCOL DESCRIPTION ICON COMMAND
  DeleteRegKey SHELL_CONTEXT "Software\Classes\${PROTOCOL}"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${PROTOCOL}" "" "${DESCRIPTION}"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${PROTOCOL}" "URL Protocol" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\${PROTOCOL}\DefaultIcon" "" "${ICON}"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${PROTOCOL}\shell" "" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\${PROTOCOL}\shell\open" "" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\${PROTOCOL}\shell\open\command" "" "${COMMAND}"
!macroend

!macro CUSTOM_PROTOCOL_UNASSOCIATE PROTOCOL
  DeleteRegKey SHELL_CONTEXT "Software\Classes\${PROTOCOL}"
!macroend

!macro wails.associateCustomProtocols
    ; Create custom protocols associations
    
!macroend

!macro wails.unassociateCustomProtocols
    ; Delete app custom protocol associations
    
!macroend