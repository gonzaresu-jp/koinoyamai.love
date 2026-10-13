; まいちゃん通知 (MaiPush) インストーラー
; ビルド手順:
;   1. Windows/mai-push-winui で dotnet publish（出力先は %LOCALAPPDATA%\MaiPushWinUI\publish）
;   2. ISCC.exe installer.iss（Inno Setup 6）
;   出力: installer\MaiPush-<MyAppVersion>-Setup.exe

#define MyAppName "まいちゃん通知"
#define MyAppVersion "1.8.0"
#define MyAppPublisher "koinoyamai"
#define MyAppURL "https://koinoyamai.love"
#define MyAppExeName "まいちゃん通知.exe"
#define PublishDir GetEnv("LOCALAPPDATA") + "\MaiPushWinUI\publish"

[Setup]
AppId={{5D8E2A17-9C4B-4F6E-A3D1-7B2C8E0F4A96}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
DefaultDirName={autopf}\Mai Push Desktop
DefaultGroupName={#MyAppName}
UninstallDisplayName={#MyAppName}
UninstallDisplayIcon={app}\{#MyAppExeName}
OutputDir=installer
OutputBaseFilename=MaiPush-{#MyAppVersion}-Setup
SetupIconFile=Assets\app-icon.ico
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "japanese"; MessagesFile: "compiler:Languages\Japanese.isl"

[Tasks]
Name: "desktopicon"; Description: "デスクトップにショートカットを作成します"; GroupDescription: "追加のアイコン:"
Name: "startup"; Description: "Windows起動時にバックグラウンドで自動起動します"; GroupDescription: "自動起動:"; Flags: unchecked

[InstallDelete]
; 旧版の残骸（古い .NET ランタイム DLL を含む）を全削除しないと、ホストがアプリ直下を
; 自己完結型の .NET ルートと誤認して「No frameworks were found」で起動に失敗する
Type: filesandordirs; Name: "{app}\*"

[Files]
Source: "{#PublishDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "MaiPushDesktop"; ValueData: """{app}\{#MyAppExeName}"" --hidden"; Flags: uninsdeletevalue; Tasks: startup

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{#MyAppName} を起動します"; Flags: nowait postinstall skipifsilent
