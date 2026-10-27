Option Explicit
Dim shell, fileSystem, directory, script
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")
directory = fileSystem.GetParentFolderName(WScript.ScriptFullName)
script = fileSystem.BuildPath(directory, "stop.ps1")

' Stop only the TPS helper; Codex remains open.
shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & script & """", 0, False
