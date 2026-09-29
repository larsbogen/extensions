import { Icon } from "@raycast/api";
import { addDays, format, isSameWeek, nextDay, startOfDay, type Day } from "date-fns";

import type { User } from "../api";

import { getToday } from "./dates";

type ScheduleSettings = Pick<User, "next_week" | "weekend_start_day" | "start_day">;

export type ScheduleOption = {
  key: string;
  title: string;
  icon: Icon | string;
  date: Date | null;
};

/** Todoist numbers weekdays from Monday (1) through Sunday (7). */
function weekday(value: number | undefined, fallback: Day): Day {
  return value !== undefined && Number.isInteger(value) && value >= 1 && value <= 7 ? ((value % 7) as Day) : fallback;
}

export function getScheduleOptions(settings?: ScheduleSettings, now = getToday()): ScheduleOption[] {
  const today = startOfDay(now);
  const weekStartsOn = weekday(settings?.start_day, 1);
  const weekendDay = weekday(settings?.weekend_start_day, 6);
  const weekend = today.getDay() === weekendDay ? today : nextDay(today, weekendDay);
  const laterThisWeek = addDays(today, 2);
  const options: ScheduleOption[] = [];

  function add(key: string, title: string, icon: Icon | string, date: Date) {
    options.push({ key, title: `${title} (${format(date, "EEE d MMM")})`, icon, date });
  }

  add("today", "Today", Icon.Calendar, today);
  add("tomorrow", "Tomorrow", Icon.Sunrise, addDays(today, 1));
  // Never silently turn "Later This Week" into a date in the following week.
  if (isSameWeek(today, laterThisWeek, { weekStartsOn })) {
    add("later-this-week", "Later This Week", Icon.Calendar, laterThisWeek);
  }
  add("weekend", isSameWeek(today, weekend, { weekStartsOn }) ? "This Weekend" : "Next Weekend", "🌴", weekend);
  add("next-week", "Next Week", Icon.ArrowRight, nextDay(today, weekday(settings?.next_week, 1)));
  options.push({ key: "no-date", title: "No Date", icon: Icon.XMarkCircle, date: null });
  return options;
}
