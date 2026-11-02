import { Notice } from "obsidian";
import { refusalText } from "../mesh/meshService.js";

export function errorText(error: unknown): string {
  if ((error as { code?: string } | null)?.code === "forbidden") return refusalText(`forbidden:${(error as Error).message}`);
  return error instanceof Error ? error.message : String(error);
}

type ActionButton = HTMLButtonElement | { setDisabled(disabled: boolean): unknown };
const pending = new WeakSet<ActionButton>();

/** The same button cannot start a second action while its first one is pending. */
export async function pendingAction(action: () => Promise<unknown>, button?: ActionButton, done?: () => void): Promise<void> {
  if (button && pending.has(button)) return;
  const disable = (disabled: boolean) => {
    if (!button) return;
    if ("setDisabled" in button) button.setDisabled(disabled);
    else { button.disabled = disabled; button.toggleAttribute("data-pending", disabled); }
  };
  if (button) pending.add(button);
  disable(true);
  try {
    await action();
    done?.();
  } catch (error) {
    new Notice(errorText(error), 8000);
  } finally {
    if (button) pending.delete(button);
    disable(false);
  }
}
