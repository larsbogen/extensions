import { environment } from "@raycast/api";
import { join } from "node:path";
import { WorkdayStore } from "./store";

export function getWorkdayStore(): WorkdayStore {
  return new WorkdayStore(join(environment.supportPath, "workdays"));
}
