Set objShell = CreateObject("WScript.Shell")
Set objFSO = CreateObject("Scripting.FileSystemObject")

strDir = objFSO.GetParentFolderName(WScript.ScriptFullName)
strFile = strDir & "\maze.html"

' Try Chrome first, then Edge
chromePath = "C:\Program Files\Google\Chrome\Application\chrome.exe"
edgePath   = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"

If objFSO.FileExists(chromePath) Then
    browser = chromePath
ElseIf objFSO.FileExists(edgePath) Then
    browser = edgePath
Else
    MsgBox "Chrome или Edge не найден.", 16, "Лабиринт"
    WScript.Quit
End If

cmd = """" & browser & """ --app=""file:///" & Replace(strFile, "\", "/") & """ --window-size=900,720 --window-position=80,40"
objShell.Run cmd, 1, False
