"use client";

import { useState } from "react";
import Link from "next/link";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    setMessage("");
    const res = await fetch("/api/auth/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const data = (await res.json().catch(() => ({}))) as { message?: string };
    setLoading(false);
    if (!res.ok) {
      setError(typeof data.message === "string" ? data.message : "提交失败");
      return;
    }
    setMessage(typeof data.message === "string" ? data.message : "已处理");
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-slate-50 dark:bg-slate-950">
      <div className="w-full max-w-md rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-sm p-6">
        <h1 className="text-lg font-semibold text-slate-800 dark:text-slate-100 mb-1">找回密码</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-6">我们将向您的邮箱发送 6 位数字验证码（15 分钟内有效）</p>
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
          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          {message && <p className="text-sm text-emerald-700 dark:text-emerald-400">{message}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full py-2 rounded bg-slate-800 dark:bg-slate-200 text-white dark:text-slate-900 text-sm font-medium disabled:opacity-50"
          >
            {loading ? "发送中…" : "发送验证码"}
          </button>
        </form>
        <p className="mt-4 text-sm">
          <Link href="/reset-password" className="text-sky-600 dark:text-sky-400 hover:underline">
            已有验证码？去重置密码
          </Link>
          {" · "}
          <Link href="/login" className="text-slate-600 dark:text-slate-400 hover:underline">
            返回登录
          </Link>
        </p>
      </div>
    </div>
  );
}
