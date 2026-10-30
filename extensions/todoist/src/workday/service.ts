import { initialSync, type SyncData } from "../api";
import { getTodoistApi } from "../helpers/withTodoistApi";
import { fetchCompletions } from "../reports/activity";
import { reportRange } from "../reports/dates";
import { osloDay } from "../remarkable/plan";
import { addTaskToPlan, createWorkday, reconcilePlan, type WorkdayPlan } from "./model";
import { getWorkdayStore } from "./runtime";

export async function freshWorkdayData(): Promise<SyncData> {
  const data = await initialSync();
  if (!data.user?.id || !Array.isArray(data.items) || !Array.isArray(data.projects)) {
    throw new Error("Todoist returnerte ufullstendige data. Arbeidsdagen er beholdt.");
  }
  return data;
}

export async function loadWorkday(now = new Date()) {
  const data = await freshWorkdayData();
  const day = osloDay(now);
  const accountId = data.user.id;
  const store = getWorkdayStore();
  const [stored, previous] = await Promise.all([store.read(accountId, day), store.latestPrevious(accountId, day)]);
  let plan = stored ?? createWorkday(accountId, day);
  if (stored) {
    const completions = await fetchCompletions(getTodoistApi(), accountId, reportRange(day, "day"), undefined, now);
    plan = await store.update(accountId, day, (current) =>
      reconcilePlan(
        current,
        data.items,
        data.projects,
        accountId,
        completions.events.map((event) => ({ taskId: event.taskId, completedAt: event.at })),
        now.toISOString(),
      ),
    );
  }
  return { data, day, plan, previous };
}

export async function addToToday(taskId: string): Promise<WorkdayPlan> {
  const observedAt = new Date().toISOString();
  const data = await freshWorkdayData();
  const task = data.items.find((item) => item.id === taskId);
  if (!task) throw new Error("Oppgaven finnes ikke lenger blant aktive oppgaver.");
  return getWorkdayStore().update(data.user.id, osloDay(new Date()), (plan) =>
    addTaskToPlan(reconcilePlan(plan, data.items, data.projects, data.user.id, [], observedAt), task, data.projects),
  );
}

export async function editWorkday(
  accountId: string,
  day: string,
  change: (plan: WorkdayPlan) => WorkdayPlan,
): Promise<WorkdayPlan> {
  const observedAt = new Date().toISOString();
  const data = await freshWorkdayData();
  if (data.user.id !== accountId) throw new Error("Todoist-kontoen er endret. Åpne arbeidsdagen på nytt.");
  if (day !== osloDay(new Date())) throw new Error("Det er en ny dag. Oppdater arbeidsdagen først.");
  return getWorkdayStore().update(accountId, day, (plan) =>
    change(reconcilePlan(plan, data.items, data.projects, accountId, [], observedAt)),
  );
}
