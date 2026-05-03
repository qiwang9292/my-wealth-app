"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [nextPath, setNextPath] = useState("/");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("next");
    if (q && q.startsWith("/")) setNextPath(q);
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = (await res.json().catch(() => ({}))) as { message?: string };
    setLoading(false);
    if (!res.ok) {
      setError(typeof data.message === "string" ? data.message : "登录失败");
      return;
    }
    router.push(nextPath);
    router.refresh();
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-slate-50 dark:bg-slate-950">
      <div className="w-full max-w-md rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-sm p-6">
        <h1 className="text-lg font-semibold text-slate-800 dark:text-slate-100 mb-1">登录</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-6">Wealth Tracker · 多用户账户</p>
        <form onSubmit={(e) => void onSubmit(e)} className="space-y-4">
          <div>
            <label className="block text-sm text-slate-600 dark:text-slate-300 mb-1">邮箱</label>
            <input
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full border border-slate-300 dark:border-slate-600 rounded px-3 py-2 bg-white dark:bg-slate-800 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-600 dark:text-slate-300 mb-1">密码</label>
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full border border-slate-300 dark:border-slate-600 rounded px-3 py-2 bg-white dark:bg-slate-800 text-sm"
            />
          </div>
          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full py-2 rounded bg-slate-800 dark:bg-slate-200 text-white dark:text-slate-900 text-sm font-medium hover:opacity-90 disabled:opacity-50"
          >
            {loading ? "登录中…" : "登录"}
          </button>
        </form>
        <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-sm text-slate-600 dark:text-slate-400">
          <Link href="/register" className="hover:underline">
            注册账号
          </Link>
          <Link href="/forgot-password" className="hover:underline">
            忘记密码
          </Link>
        </div>
      </div>
    </div>
  );
}
