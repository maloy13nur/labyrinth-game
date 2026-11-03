' Launcher for Rupor: opens the app in a standalone Chrome/Edge window.
' Content is ASCII-only so the file stays readable in any code page.
Set objShell = CreateObject("WScript.Shell")
Set objFSO = CreateObject("Scripting.FileSystemObject")

strDir = objFSO.GetParentFolderName(WScript.ScriptFullName)
strFile = strDir & "\rupor.html"

If Not objFSO.FileExists(strFile) Then
    MsgBox "rupor.html was not found next to this launcher.", 16, "Rupor"
    WScript.Quit
End If

chromePath = "C:\Program Files\Google\Chrome\Application\chrome.exe"
chromePath86 = "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
edgePath64 = "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
edgePath = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"

If objFSO.FileExists(chromePath) Then
    browser = chromePath
ElseIf objFSO.FileExists(chromePath86) Then
    browser = chromePath86
ElseIf objFSO.FileExists(edgePath64) Then
    browser = edgePath64
ElseIf objFSO.FileExists(edgePath) Then
    browser = edgePath
Else
    MsgBox "Chrome or Edge was not found on this computer.", 16, "Rupor"
    WScript.Quit
End If

url = "file:///" & Replace(strFile, "\", "/")

' A dedicated profile keeps the app window separate from normal browsing.
profileDir = objShell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Rupor"

cmd = """" & browser & """" & _
      " --app=""" & url & """" & _
      " --user-data-dir=""" & profileDir & """" & _
      " --window-size=1280,800" & _
      " --window-position=80,40" & _
      " --no-first-run --no-default-browser-check"

objShell.Run cmd, 1, False
