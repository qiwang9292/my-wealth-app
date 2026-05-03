"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PasswordInput } from "@/components/PasswordInput";

export default function AccountPasswordPage() {
  const [email, setEmail] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [sendMsg, setSendMsg] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((u: { email?: string } | null) => {
        setEmail(typeof u?.email === "string" ? u.email : null);
      })
      .catch(() => setEmail(null));
  }, []);

  async function sendCode() {
    setSending(true);
    setSendError(null);
    setSendMsg(null);
    const res = await fetch("/api/auth/change-password/send-code", { method: "POST" });
    const data = (await res.json().catch(() => ({}))) as { message?: string };
    setSending(false);
    if (!res.ok) {
      setSendError(typeof data.message === "string" ? data.message : "发送失败");
      return;
    }
    setSendMsg(typeof data.message === "string" ? data.message : "已发送");
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setConfirmError(null);
    if (newPassword !== confirmPassword) {
      setConfirmError("两次输入的新密码不一致。");
      return;
    }
    setSubmitting(true);
    const res = await fetch("/api/auth/change-password/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, newPassword }),
    });
    const data = (await res.json().catch(() => ({}))) as { message?: string };
    setSubmitting(false);
    if (!res.ok) {
      setConfirmError(typeof data.message === "string" ? data.message : "修改失败");
      return;
    }
    window.location.href = "/login";
  }

  return (
    <div className="min-h-screen p-4 max-w-md mx-auto">
      <header className="mb-6 flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-slate-800 dark:text-slate-100">修改密码</h1>
        <Link href="/" className="text-sm text-sky-600 dark:text-sky-400 hover:underline">
          返回总览
        </Link>
      </header>

      <p className="text-sm text-slate-600 dark:text-slate-400 mb-4">
        验证码将发送至注册邮箱{" "}
        <span className="font-mono text-slate-800 dark:text-slate-200">{email ?? "…"}</span>
        ，有效期 15 分钟。
      </p>

      <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4 space-y-4">
        <button
          type="button"
          disabled={sending || !email}
          onClick={() => void sendCode()}
          className="w-full py-2 rounded border border-slate-300 dark:border-slate-600 text-sm font-medium hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
        >
          {sending ? "发送中…" : "发送验证码到邮箱"}
        </button>
        {sendError && <p className="text-sm text-red-600 dark:text-red-400">{sendError}</p>}
        {sendMsg && <p className="text-sm text-emerald-700 dark:text-emerald-400">{sendMsg}</p>}

        <form onSubmit={(e) => void onSubmit(e)} className="space-y-3 pt-2 border-t border-slate-100 dark:border-slate-800">
          <div>
            <label className="block text-xs text-slate-500 mb-1">邮箱验证码</label>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              placeholder="6 位数字"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              className="w-full border border-slate-300 dark:border-slate-600 rounded px-3 py-2 bg-white dark:bg-slate-800 text-sm font-mono"
            />
          </div>
          <div>
            <label htmlFor="account-password-new" className="block text-xs text-slate-500 mb-1">
              新密码（至少 8 位）
            </label>
            <PasswordInput
              id="account-password-new"
              autoComplete="new-password"
              minLength={8}
              value={newPassword}
              onChange={setNewPassword}
            />
          </div>
          <div>
            <label htmlFor="account-password-confirm" className="block text-xs text-slate-500 mb-1">
              确认新密码
            </label>
            <PasswordInput
              id="account-password-confirm"
              autoComplete="new-password"
              minLength={8}
              value={confirmPassword}
              onChange={setConfirmPassword}
            />
          </div>
          {confirmError && <p className="text-sm text-red-600 dark:text-red-400">{confirmError}</p>}
          <button
            type="submit"
            disabled={submitting}
            className="w-full py-2 rounded bg-slate-800 dark:bg-slate-200 text-white dark:text-slate-900 text-sm font-medium disabled:opacity-50"
          >
            {submitting ? "提交中…" : "确认修改密码"}
          </button>
        </form>
      </div>

      <p className="mt-4 text-xs text-slate-500">
        修改成功后将退出登录。未配置 SMTP 时，验证码只在服务器终端日志中输出。
      </p>
    </div>
  );
}
