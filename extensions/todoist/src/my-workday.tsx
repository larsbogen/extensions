import type { LaunchProps } from "@raycast/api";
import { WorkdayView } from "./components/Workday";
import { withTodoistApi } from "./helpers/withTodoistApi";

export function MyWorkday({ launchContext }: LaunchProps<{ launchContext: { pickTasks?: boolean } }>) {
  return <WorkdayView pickTasks={launchContext?.pickTasks} />;
}

export default withTodoistApi(MyWorkday);
