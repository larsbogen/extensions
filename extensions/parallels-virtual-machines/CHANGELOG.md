# Parallels Virtual Machines Changelog

## [Local Fork: Reliable VM Controls] - 2026-10-16

- Add configurable Open Windows and Open Ubuntu commands for hotkeys and aliases.
- Open registered VM files in Parallels instead of generating AppleScript from names.
- Handle stopped, paused, suspended and transitioning VMs with awaited operations.
- Validate CLI responses; show specific errors, progress and bounded timeouts.
- Reconcile VM status after timeouts without repeating power commands.
- Add normal Shut Down VM with no automatic force fallback.
- Require confirmation for Force Stop and Reset; remove Start Then Force Stop.
- Rename global shutdown to Quit Parallels Desktop, remove force, and block active VMs.
- Add list refresh, Vitest coverage and local installation instructions.

## [New Commands] - 2025-11-07

- Improve action panel by removing duplicate commands
- Improve OS icon matching when viewing list of VMs
- Add `Force Stop` and `Reset` actions for running VMs
- Add `Start then Force Stop` action for suspended VMs
- Add Shut Down command to correctly shut down Parallels and services.
- Add icons to VM control actions in action panel

## [Update] - 2024-01-05

- Added error handling for when AppleScript can't launch VM.
- Updated Raycast API version and dependencies.

## [Initial Version] - 2022-09-17

- Listing of virtual machines
- Open, resume, and suspend actions
