@echo off
rem Windows launch shim for the synthetic codex. Copied by the tests into a private bin directory
rem as codex.cmd, beside fake-codex.mjs. %* forwards the argument text untouched, so a token such
rem as windows.sandbox=elevated reaches Node as one argument exactly as the relay emitted it.
"node" "%~dp0fake-codex.mjs" %*
exit /b %ERRORLEVEL%
