export type { VM };
export { VMState, VMAction };

interface VM {
  id: string;
  name: string;
  description: string;
  os: string;
  state: VMState;
  rawState: string;
  home?: string;
}

enum VMState {
  Stopped = "stopped",
  Starting = "starting",
  Resuming = "resuming",
  Running = "running",
  Suspended = "suspended",
  Paused = "paused",
  Stopping = "stopping",
  Suspending = "suspending",
  Pausing = "pausing",
  Unavailable = "unavailable",
  Unknown = "unknown",
}

enum VMAction {
  Suspend = "suspend",
  Stop = "shutdown",
  ForceStop = "force-stop",
  Reset = "reset",
}
