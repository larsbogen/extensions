import { showToast, Toast, Cache, closeMainWindow } from "@raycast/api";
import { showFailureToast } from "@raycast/utils";

import { stopFocusPanel } from "./focus/panel";
import { refreshMenuBarCommand } from "./helpers/menu-bar";

const cache = new Cache();

const command = async () => {
  try {
    const raw = cache.get("todoist.focusedTask");
    const task = raw ? JSON.parse(raw) : undefined;
    await stopFocusPanel(task?.id);
    cache.set("todoist.focusedTask", JSON.stringify({ id: "", content: "" }));
    await closeMainWindow();
    await showToast({ style: Toast.Style.Success, title: "No more focused task" });
    await refreshMenuBarCommand();
  } catch (error) {
    await showFailureToast(error, { title: "Unable to unfocus task" });
  }
};

export default command;
