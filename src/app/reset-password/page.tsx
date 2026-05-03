"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PasswordInput } from "@/components/PasswordInput";

export default function ResetPasswordPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [sentNotice, setSentNotice] = useState(false);

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const e = sp.get("email");
    if (e) setEmail(decodeURIComponent(e));
    if (sp.get("sent") === "1") setSentNotice(true);
  }, []);

  async function onSubmit(ev: React.FormEvent) {
    ev.preventDefault();
    setError("");
    setMessage("");
    if (password !== confirmPassword) {
      setError("两次输入的新密码不一致。");
      return;
    }
    setLoading(true);
    const res = await fetch("/api/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, code, password }),
    });
    const data = (await res.json().catch(() => ({}))) as { message?: string };
    setLoading(false);
    if (!res.ok) {
      setError(typeof data.message === "string" ? data.message : "重置失败");
      return;
    }
    setMessage(typeof data.message === "string" ? data.message : "已重置");
    setTimeout(() => {
      router.push("/login");
      router.refresh();
    }, 1200);
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-slate-50 dark:bg-slate-950">
      <div className="w-full max-w-md rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-sm p-6">
        <h1 className="text-lg font-semibold text-slate-800 dark:text-slate-100 mb-1">重置密码</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-6">
          输入邮箱、邮件中的 6 位验证码与新密码（需填写两次新密码以确认）
        </p>
        {sentNotice && (
          <p className="text-sm text-emerald-700 dark:text-emerald-400 mb-4 rounded-lg border border-emerald-200 dark:border-emerald-800 bg-emerald-50/80 dark:bg-emerald-950/40 px-3 py-2">
            若该邮箱已注册，验证码已发送，请查收邮件（未配置 SMTP 时请查看服务端日志）。
          </p>
        )}
        <form onSubmit={(e) => void onSubmit(e)} className="space-y-4">
          <div>
            <label className="block text-sm text-slate-600 dark:text-slate-300 mb-1">邮箱</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full border border-slate-300 dark:border-slate-600 rounded px-3 py-2 bg-white dark:bg-slate-800 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-600 dark:text-slate-300 mb-1">验证码</label>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              placeholder="6 位数字"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              className="w-full border border-slate-300 dark:border-slate-600 rounded px-3 py-2 bg-white dark:bg-slate-800 text-sm font-mono"
            />
          </div>
          <div>
            <label htmlFor="reset-password-new" className="block text-sm text-slate-600 dark:text-slate-300 mb-1">
              新密码（至少 8 位）
            </label>
            <PasswordInput
              id="reset-password-new"
              autoComplete="new-password"
              required
              minLength={8}
              value={password}
              onChange={setPassword}
            />
          </div>
          <div>
            <label htmlFor="reset-password-confirm" className="block text-sm text-slate-600 dark:text-slate-300 mb-1">
              确认新密码
            </label>
            <PasswordInput
              id="reset-password-confirm"
              autoComplete="new-password"
              required
              minLength={8}
              value={confirmPassword}
              onChange={setConfirmPassword}
            />
          </div>
          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          {message && <p className="text-sm text-emerald-700 dark:text-emerald-400">{message}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full py-2 rounded bg-slate-800 dark:bg-slate-200 text-white dark:text-slate-900 text-sm font-medium disabled:opacity-50"
          >
            {loading ? "提交中…" : "重置密码"}
          </button>
        </form>
        <p className="mt-4 text-sm">
          <Link href="/login" className="text-sky-600 dark:text-sky-400 hover:underline">
            返回登录
          </Link>
        </p>
      </div>
    </div>
  );
}
