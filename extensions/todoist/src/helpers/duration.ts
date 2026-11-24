import type { Task } from "../api";

export function isValidDuration(duration: Task["duration"]): duration is NonNullable<Task["duration"]> {
  return (
    duration != null &&
    (duration.unit === "minute" || duration.unit === "day") &&
    Number.isInteger(duration.amount) &&
    duration.amount > 0
  );
}
