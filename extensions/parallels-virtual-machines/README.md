# Parallels Virtual Machines

Open Windows or Ubuntu directly from Raycast, or browse and control all registered
virtual machines. Requires Parallels Desktop with command-line support (Pro,
Business or Enterprise) and its `/usr/local/bin/prlctl` and `prlsrvctl` wrappers.

## Commands

- **Open Windows**: defaults to `Windows 11`.
- **Open Ubuntu**: defaults to `Ubuntu 26.04 ARM64`.
- **Show Virtual Machines**: browse VM status, open, suspend or shut down a VM.
  Refresh with **⌘R**. Paused VMs can be resumed or suspended.
- **Quit Parallels Desktop**: quits services without force, after every VM has
  been shut down or suspended. It lists any VMs that must be handled first.

The direct commands start a stopped VM, resume a paused/suspended VM, or wait for
an existing startup. They open the VM's actual registered file in Parallels and
respect its existing display settings. They never choose a similarly named VM.
Stopping, unavailable and unknown states produce an explanation instead.

In Raycast Settings → Extensions → Parallels Virtual Machines, select **Open
Windows** or **Open Ubuntu** to change **Virtual Machine Name or UUID**, and assign
a hotkey or alias. Use an exact registered name or UUID. A UUID continues to work
after renaming a VM; duplicate names require a UUID. A missing/ambiguous target
offers **Open Command Settings** in its error toast.
On first use, Raycast asks you to confirm the prefilled target once.

**Shut Down VM** requests normal shutdown using `--noforce`. It never escalates to
a hard stop. **Force Stop** and **Reset** are separate destructive actions and
require confirmation naming the VM and warning about lost unsaved work. There is
no timer-based "start then force stop" action.

Reads have a 30-second limit. State changes have a 120-second limit and poll every
two seconds. On timeout the extension checks the current VM state once more and
does not repeat the power command. If status cannot be confirmed, check Parallels
before retrying. "Running" means the VM is powered on, not that guest login or
all guest services have finished loading.

## Local development and installation

From this extension's directory:

```sh
npm ci
npm test
npm run build
npm run typecheck
npm run lint
npm run dev
```

`npm run dev` registers and loads this local version in Raycast. Commands appear
with a development marker. Assign shortcuts in Raycast Settings. If a Store
version is also installed, disable its duplicate commands to keep shortcuts clear.
To refresh the local build after later changes, run `npm run dev` again.

Tests mock CLI and Raycast calls; they never start, stop or reset real VMs. Native
Raycast verification is separate. Save work in guests before testing real normal
shutdown/startup. Verify force/reset cancellation only on active work VMs.
