' Inicializador Inteligente e Invisível do Painel de Estudos (Porta 3000)
' - Se estiver desligado: liga em segundo plano (sem janela preta) e abre o navegador.
' - Se já estiver rodando: pergunta se você quer Abrir o navegador, Reiniciar o servidor ou Desligar!

Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

projectDir = fso.GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = projectDir

' Função auxiliar que encerra apenas o processo que está escutando na porta 3000
Sub StopServerOnPort3000()
    WshShell.Run "cmd /c ""for /f ""tokens=5"" %a in ('netstat -ano ^| findstr "":3000 "" ^| findstr ""LISTENING""') do taskkill /F /PID %a""", 0, True
    WScript.Sleep 600
End Sub

' Verifica se a porta 3000 já está ativa
ret = WshShell.Run("cmd /c netstat -ano | findstr "":3000 "" | findstr ""LISTENING""", 0, True)

If ret <> 0 Then
    ' Não está rodando: inicia em modo oculto (0) e abre o navegador direto
    WshShell.Run "cmd /c node server.js", 0, False
    WScript.Sleep 1500
    WshShell.Run "http://localhost:3000", 1, False
Else
    ' Já está rodando: oferece as 3 opções num único atalho!
    msg = "O servidor do Painel de Estudos já está ativo em segundo plano (porta 3000)." & vbCrLf & vbCrLf & _
          "O que você deseja fazer?" & vbCrLf & vbCrLf & _
          "• Clique em [SIM] para apenas abrir o Painel no navegador" & vbCrLf & _
          "• Clique em [NÃO] para REINICIAR o servidor agora" & vbCrLf & _
          "• Clique em [CANCELAR] para DESLIGAR o servidor em segundo plano"

    escolha = MsgBox(msg, vbYesNoCancel + vbQuestion, "Painel de Estudos — Controle do Servidor")

    If escolha = vbYes Then
        ' Apenas abre o navegador
        WshShell.Run "http://localhost:3000", 1, False
    ElseIf escolha = vbNo Then
        ' Reinicia o servidor na porta 3000 e abre o navegador
        StopServerOnPort3000()
        WshShell.Run "cmd /c node server.js", 0, False
        WScript.Sleep 1500
        MsgBox "Servidor reiniciado com sucesso!", vbInformation, "Painel de Estudos"
        WshShell.Run "http://localhost:3000", 1, False
    ElseIf escolha = vbCancel Then
        ' Desliga o servidor na porta 3000
        StopServerOnPort3000()
        MsgBox "Servidor em segundo plano encerrado.", vbInformation, "Painel de Estudos"
    End If
End If
