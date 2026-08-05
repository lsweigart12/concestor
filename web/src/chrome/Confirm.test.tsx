/**
 * The one dialog in the app, and the only thing standing between `C` and an
 * hour of assembled tree.
 *
 * Small enough to read in a minute and worth a test for exactly that reason:
 * every rule in it is a one-line condition that would fail silently. The
 * confirming button takes focus after paint — which is what makes Enter and
 * Space confirm without the app's key handler needing a rule of its own — and
 * the scrim cancels on a press that lands *on the scrim*, not on a press that
 * merely bubbles up through the panel. Get the second one wrong and the dialog
 * dismisses itself when the reader clicks its own title.
 *
 * Real timers here, deliberately. The focus lands in a `requestAnimationFrame`
 * callback, so the thing under test is a frame boundary rather than a delay,
 * and `findBy*` waits for it the way a reader does.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Confirm } from "./Confirm";

function mount(over: Partial<Parameters<typeof Confirm>[0]> = {}) {
  const props = {
    title: "Clear the canvas?",
    body: "Six species and two fossils will be removed.",
    confirmLabel: "Clear",
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    ...over,
  };
  render(<Confirm {...props} />);
  return props;
}

describe("Confirm", () => {
  it("gives focus to the confirming button, after paint", async () => {
    mount();
    const confirm = await screen.findByRole("button", { name: /Clear/ });
    // Not merely present: focused. The app's key handler has the modal, and
    // nothing in it says what Enter does — this does.
    expect(document.activeElement).toBe(confirm);
  });

  it("is a modal dialog labelled by its own title", () => {
    mount();
    const dialog = screen.getByRole("dialog", { name: "Clear the canvas?" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.textContent).toContain(
      "Six species and two fossils will be removed.",
    );
  });

  it("runs the two answers from the two buttons", () => {
    const { onConfirm, onCancel } = mount();

    fireEvent.click(screen.getByRole("button", { name: /Cancel/ }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Clear/ }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("cancels on a press on the scrim and not on one inside the panel", () => {
    const { onCancel } = mount();
    const dialog = screen.getByRole("dialog");
    const scrim = dialog.parentElement;
    expect(scrim?.className).toBe("modal-scrim");

    // A press on the panel bubbles to the scrim's handler. Only the target
    // check keeps it from closing the dialog the reader is reading.
    fireEvent.mouseDown(dialog);
    expect(onCancel).not.toHaveBeenCalled();

    fireEvent.mouseDown(scrim!);
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
