.PHONY: help check-prereqs install test build-ui installer installer-msi installer-nsis clean

POWERSHELL := powershell -NoProfile -ExecutionPolicy Bypass -Command
PDFIUM_DLL := src-tauri/resources/pdfium/windows-x64/bin/pdfium.dll
BUNDLE_DIR := src-tauri/target/release/bundle

help:
	@echo Available targets:
	@echo "  make check-prereqs  Verify toolchain and bundled PDFium prerequisites"
	@echo "  make install        Install Node dependencies"
	@echo "  make test           Run frontend tests"
	@echo "  make build-ui       Build the frontend bundle"
	@echo "  make installer      Build both Windows installers (.msi and NSIS .exe)"
	@echo "  make installer-msi  Build only the Windows MSI installer"
	@echo "  make installer-nsis Build only the Windows NSIS installer"
	@echo "  make clean          Remove generated frontend and Tauri build output"

check-prereqs:
	@$(POWERSHELL) "$$ErrorActionPreference = 'Stop'; \
	if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node is not installed or not on PATH.' }; \
	if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw 'npm is not installed or not on PATH.' }; \
	if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) { throw 'cargo is not installed or not on PATH.' }; \
	if (-not (Get-Command rustc -ErrorAction SilentlyContinue)) { throw 'rustc is not installed or not on PATH.' }; \
	if (-not (Get-Command link.exe -ErrorAction SilentlyContinue)) { throw 'link.exe was not found. Install Microsoft C++ Build Tools with the MSVC toolchain.' }; \
	if (-not (Test-Path '$(PDFIUM_DLL)')) { throw 'Bundled PDFium DLL is missing at $(PDFIUM_DLL).' }; \
	Write-Host 'Prerequisites look good.'"

install:
	npm install

test:
	npm test

build-ui:
	npm run build

installer: check-prereqs test
	npm run tauri -- build --bundles msi nsis
	@$(POWERSHELL) "Write-Host 'Installers written under $(BUNDLE_DIR)'"

installer-msi: check-prereqs test
	npm run tauri -- build --bundles msi
	@$(POWERSHELL) "Write-Host 'MSI bundle written under $(BUNDLE_DIR)'"

installer-nsis: check-prereqs test
	npm run tauri -- build --bundles nsis
	@$(POWERSHELL) "Write-Host 'NSIS bundle written under $(BUNDLE_DIR)'"

clean:
	@$(POWERSHELL) "$$ErrorActionPreference = 'Stop'; \
	if (Test-Path 'dist') { Remove-Item 'dist' -Recurse -Force }; \
	if (Test-Path 'src-tauri/target') { Remove-Item 'src-tauri/target' -Recurse -Force }; \
	Write-Host 'Removed dist and src-tauri/target if they existed.'"
