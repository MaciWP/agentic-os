@echo off
rem aos on Windows, which ignores the shebang in bin\aos.
bun "%~dp0..\scripts\aos.ts" %*
