// UX workstream 4: shared modal family extracted from the inline markup that
// used to live in DataBrowser.tsx (`.modal-backdrop` / `.modal` /
// `.modal-actions` CSS in index.css). Replaces every native prompt() /
// confirm() call in the web UI.

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

export function Modal({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        {children}
        {footer ? <div className="modal-actions">{footer}</div> : null}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="action" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`action ${danger ? "danger" : "primary"}`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      {typeof message === "string" ? <p className="muted">{message}</p> : message}
    </Modal>
  );
}

export function PromptDialog({
  title,
  message,
  initialValue = "",
  placeholder,
  confirmLabel = "OK",
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
}: {
  title: string;
  message?: ReactNode;
  initialValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="action" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className="action primary"
            disabled={value.trim().length === 0}
            onClick={() => onConfirm(value.trim())}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      {message ? (
        typeof message === "string" ? (
          <p className="muted">{message}</p>
        ) : (
          message
        )
      ) : null}
      <input
        ref={inputRef}
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && value.trim().length > 0) {
            onConfirm(value.trim());
          }
        }}
      />
    </Modal>
  );
}
