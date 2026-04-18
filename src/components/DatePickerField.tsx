"use client";

import { useRef } from "react";

type Props = {
  value: string;
  onChange: (isoDateYyyyMmDd: string) => void;
  className?: string;
  /** 传给 input；可用于弹窗内避免 id 冲突 */
  id?: string;
  disabled?: boolean;
};

/**
 * 原生 date：点击输入框或「日历」按钮时尽量调用 showPicker()，弹出系统日历面板。
 */
export function DatePickerField({ value, onChange, className, id, disabled }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  const openPicker = () => {
    const el = inputRef.current;
    if (!el || disabled) return;
    el.focus();
    if (typeof el.showPicker === "function") {
      el.showPicker();
    }
  };

  return (
    <div className={`flex gap-1.5 items-stretch ${className ?? ""}`}>
      <input
        ref={inputRef}
        id={id}
        type="date"
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onClick={openPicker}
        className="flex-1 min-w-0 border border-slate-300 dark:border-slate-600 rounded px-2 py-1.5 bg-white dark:bg-slate-900 text-sm"
      />
      <button
        type="button"
        disabled={disabled}
        onClick={openPicker}
        className="shrink-0 px-2.5 py-1.5 text-xs rounded border border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-50"
        title="打开日历"
      >
        日历
      </button>
    </div>
  );
}
