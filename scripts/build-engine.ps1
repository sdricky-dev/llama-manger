<#
  LlamaManger · Windows 引擎构建脚本（PowerShell）

  用法（在 PowerShell 里）：
    .\scripts\build-engine.ps1                       # 默认仓库路径 ~\llama.cpp
    .\scripts\build-engine.ps1 -Repo D:\llama.cpp   # 指定仓库
    .\scripts\build-engine.ps1 -Clean               # 先删 build 目录再构建

  前置条件（任一即可）：
    A. Visual Studio 2022（含“使用 C++ 的桌面开发”）+ CMake，用 MSVC 构建
    B. LLVM/clang + ninja + CMake
  说明：Windows 上 MSVC 是多配置生成器，产物在 build\bin\Release\，
        启动器已能自动识别该目录（也会识别 build\bin\）。
#>
param(
  [string]$Repo = "$HOME\llama.cpp",
  [switch]$Clean,
  [int]$Jobs = 0
)

$ErrorActionPreference = 'Stop'

function Require-Cmd($name, $hint) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    throw "找不到 $name。$hint"
  }
}

Require-Cmd cmake "请安装 CMake 并加入 PATH（https://cmake.org/download/ 或 winget install Kitware.CMake）"

if (-not (Test-Path (Join-Path $Repo 'CMakeLists.txt'))) {
  throw "看起来不是 llama.cpp 仓库：$Repo（找不到 CMakeLists.txt）"
}

$build = Join-Path $Repo 'build'
if ($Clean -and (Test-Path $build)) {
  Write-Host "清理 $build ..." -ForegroundColor Yellow
  Remove-Item -Recurse -Force $build
}

if ($Jobs -le 0) { $Jobs = [Environment]::ProcessorCount }

$configArgs = @(
  '-S', $Repo,
  '-B', $build,
  '-DCMAKE_BUILD_TYPE=Release',
  '-DLLAMA_BUILD_SERVER=ON',
  '-DLLAMA_BUILD_UI=ON',
  '-DGGML_NATIVE=ON'
)

# 优先 MSVC（原生 Windows 性能最好），否则退回默认生成器
if (Get-Command cl.exe -ErrorAction SilentlyContinue) {
  Write-Host '使用 MSVC 工具链' -ForegroundColor Cyan
} elseif (Get-Command ninja -ErrorAction SilentlyContinue) {
  Write-Host '使用 Ninja 生成器' -ForegroundColor Cyan
  $configArgs += '-G', 'Ninja'
} else {
  Write-Host '未检测到 cl.exe / ninja，交由 CMake 自动选择生成器' -ForegroundColor Yellow
}

Write-Host "配置中：$Repo" -ForegroundColor Cyan
& cmake @configArgs

Write-Host "构建中（-j $Jobs）..." -ForegroundColor Cyan
& cmake --build $build --config Release --target llama-server llama-cli llama-fit-params -j $Jobs

$exe = Join-Path $build 'bin\Release\llama-server.exe'
if (-not (Test-Path $exe)) { $exe = Join-Path $build 'bin\llama-server.exe' }
if (Test-Path $exe) {
  Write-Host "`n✓ 构建完成：$exe" -ForegroundColor Green
  Write-Host '  在 LlamaManger 的「llama.cpp build 目录」里填：' -NoNewline
  Write-Host $build -ForegroundColor Green
} else {
  Write-Host "`n⚠ 构建结束但未找到 llama-server.exe，请检查上面的输出。" -ForegroundColor Yellow
}
