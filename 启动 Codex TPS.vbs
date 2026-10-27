Option Explicit
Dim shell, fileSystem, directory, script
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")
directory = fileSystem.GetParentFolderName(WScript.ScriptFullName)
script = fileSystem.BuildPath(directory, "start.ps1")

' Run the launcher invisibly; the actual Codex window opens normally.
shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & script & """", 0, False
