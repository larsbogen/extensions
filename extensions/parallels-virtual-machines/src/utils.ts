import { Image } from "@raycast/api";

import { VM, VMState } from "./types";

export { stateToDescription, iconForVM };

function stateToDescription(state: VMState, rawState?: string): string {
  switch (state) {
    case VMState.Stopped:
      return "Stopped";
    case VMState.Starting:
      return "Starting…";
    case VMState.Resuming:
      return "Resuming…";
    case VMState.Running:
      return "Running";
    case VMState.Suspended:
      return "Suspended";
    case VMState.Paused:
      return "Paused";
    case VMState.Stopping:
      return "Stopping…";
    case VMState.Suspending:
      return "Suspending…";
    case VMState.Pausing:
      return "Pausing…";
    case VMState.Unavailable:
      return "Unavailable";
    case VMState.Unknown:
      return rawState ? `Unknown (${rawState})` : "Unknown";
  }
}

function iconForVM(vm: VM): Image {
  const raw = vm.os || "";
  const os = raw.toLowerCase();

  let icon = "other";

  if (os.includes("fedora")) {
    icon = "fedora";
  } else if (os.includes("ubuntu")) {
    icon = "ubuntu";
  } else if (os.includes("debian")) {
    icon = "debian";
  } else if (os.includes("kali")) {
    icon = "kali";
  } else if (os.includes("centos")) {
    icon = "centos";
  } else if (
    os.includes("mac") ||
    os.includes("os x") ||
    os.includes("osx") ||
    os.includes("darwin") ||
    os.includes("macos")
  ) {
    icon = "macos";
  } else if (os.includes("windows") || os.includes("win")) {
    if (os.includes("11")) {
      icon = "win-11";
    } else if (os.includes("10")) {
      icon = "win-10";
    } else {
      icon = "win-other";
    }
  } else if (["redhat", "mint", "opensuse", "manjaro", "arch", "linux", "lin"].some((k) => os.includes(k))) {
    icon = "linux";
  }

  return { source: `osicons/${icon}.png` };
}
