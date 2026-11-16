# Lunex

**Lunex** is a lightweight desktop application for managing Steam games, Lua manifests (`.lua`), and depot manifest files (`.manifest`) through a clean, modern dark interface.

## Core Features

### 1. Game Library
- **Automatic Steam Discovery**: Locates Steam via Windows Registry (`HKCU\Software\Valve\Steam`) and standard installation paths, parsing `steamapps/libraryfolders.vdf` and `appmanifest_*.acf` across drives.
- **Searchable Library**: Filter and sort games by title, Steam AppID, installation status, or linked manifests (`Ctrl+K`).
- **Rich Status Cards**: Displays game artwork/emblems, copyable AppIDs, disk usage, installation badges (`Installed`, `Update Queued`, `Manifest Linked`, `Not Installed`), and `.lua` / `.manifest` counts.
- **Manual AppID Registration**: Add any Steam game directly by its numeric AppID.

### 2. Manifest Manager
- **Drag-and-Drop & Multi-File Import**: Import `.lua` scripts and `.manifest` depot files (or paste Lua directives directly).
- **Steam Plugin Standard Layout**: Places `.lua` files in `Steam/config/stplug-in` and `.manifest` files in `Steam/depotcache` by default.
- **AppID Association**: Automatically extracts AppIDs and depot directives (`addappid`, `setManifestid`) and lets you link or reassign files to specific Steam AppIDs.
- **Duplicate & Integrity Detection**: Computes SHA-256 checksums to flag duplicate files, verifies Valve `0x71F617D0` DepotManifest binary headers, and validates Lua syntax prior to import.
- **Automatic Backups & One-Click Restore**: Archives existing manifests before replacing or deleting them, with instant restore from the Backups drawer.

### 3. File Management & Settings
- **Directory Health & Custom Paths**: Configure custom Steam, `.lua` (`stplug-in`), `.manifest` (`depotcache`), and backup directories with live read/write verification.
- **Operations Log**: Track timestamped successful, warning, and failed file operations.
- **Windows Integration**: Native frameless dark window controls and optional **Launch with Windows** startup registration.

## Getting Started

```bash
# Install dependencies
npm install

# Start interactive web & API dev server
npm run dev

# Launch native Electron desktop window in development
npm run electron:dev

# Run automated test suite
npm test

# Build production Windows installer & portable executable
npm run electron:build
```
