/**
 * The one dialog in the app, and the exception is deliberate.
 *
 * Everything else confirms in a HUD toast *after* the fact, because everything
 * else is either additive or one keystroke from being undone. Clearing is
 * neither: it is now a single unshifted letter, it is the only action that can
 * destroy an hour of assembling a tree, and `C` sits next to `F` and `R` on the
 * same hand. A toast reading "Canvas cleared" is a report of the accident, not
 * a chance to avoid it.
 *
 * Kept as small as a dialog can be: it states what will go, and its two buttons
 * are the two answers. Escape cancels — handled by the app's key handler, which
 * gives the modal the keyboard while it is open — and the confirming button
 * takes focus, so Enter and Space confirm without the handler needing a rule of
 * its own.
 */

import { useEffect, useRef } from "react";

export function Confirm({
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: React.ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // After paint, for the same reason the palette focuses that way: the
    // element has to exist before the caret can land in it.
    requestAnimationFrame(() => ref.current?.focus());
  }, []);

  return (
    <div
      className="modal-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <h2 className="modal-title">{title}</h2>
        <p className="modal-body">{body}</p>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel}>
            <span className="kbd">esc</span> Cancel
          </button>
          <button
            ref={ref}
            type="button"
            className="btn btn-danger"
            onClick={onConfirm}
          >
            <span className="kbd">↵</span> {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
