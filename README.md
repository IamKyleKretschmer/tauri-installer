# K2 Setup — Tauri + Textura Desktop Installer Spike

Sprint 1 spike validating that a Textura-styled React UI can run inside a
native Tauri/WebView2 window and call into .NET Framework 4.8 logic via IPC.

## Stack

- Desktop shell: Tauri v2 (Rust)
- Frontend: React 18 + TypeScript + Vite
- Design system: custom CSS approximating `@exp-textura/react` (private
  package not installable in this environment — see Notes)
- Backend IPC: Tauri commands (`src-tauri/src/commands.rs`) → `child_process`
  → .NET
- .NET target: `.NET Framework 4.8` console exe (`DotNetRunner/`)

## Structure

```
src/                    React frontend
  steps/                One component per wizard step
  components/            Sidebar, WizardShell, Textura-style primitives
  services/
    tauri.bridge.ts      Only module that calls invoke()
    installer.service.ts Business logic, calls the bridge
src-tauri/               Rust/Tauri backend
  src/commands.rs         hello / detect_dotnet / run_dotnet commands
DotNetRunner/             .NET Framework 4.8 console app
```

## Running

Requires Windows (or Linux with `webkit2gtk`/`gdk` dev libs installed) plus
Rust and Node 18+.

```
npm install
npm run tauri dev
```

Build the .NET runner separately so `run_dotnet` has something to spawn:

```
cd DotNetRunner
dotnet build
```

## Notes

- `@exp-textura/react` is a private Nintex Azure Artifacts package and isn't
  installable in this environment, so the UI (`src/components/primitives.tsx`)
  ships hand-built `Button` / `TextInput` / `Select` stand-ins styled to match
  the Nintex K2 Setup reference screenshots. Swap these for the real Textura
  components once registry access (or a local `exp-textura` build) is
  available.
- This container has no `webkit2gtk`/`gdk` system libraries, so
  `cargo check` fails at the linking step for the GTK WebView backend — the
  Rust source itself compiles cleanly. The app targets Windows/WebView2 per
  the spec.
