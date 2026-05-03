"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export default function RegisterPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = (await res.json().catch(() => ({}))) as { message?: string };
    setLoading(false);
    if (!res.ok) {
      setError(typeof data.message === "string" ? data.message : "注册失败");
      return;
    }
    router.push("/");
    router.refresh();
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-slate-50 dark:bg-slate-950">
      <div className="w-full max-w-md rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-sm p-6">
        <h1 className="text-lg font-semibold text-slate-800 dark:text-slate-100 mb-1">注册</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-6">使用邮箱与密码创建账户（密码至少 8 位）</p>
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
              autoComplete="new-password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full border border-slate-300 dark:border-slate-600 rounded px-3 py-2 bg-white dark:bg-slate-800 text-sm"
            />
          </div>
          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full py-2 rounded bg-emerald-700 text-white text-sm font-medium hover:bg-emerald-600 disabled:opacity-50"
          >
            {loading ? "注册中…" : "注册并登录"}
          </button>
        </form>
        <p className="mt-4 text-sm text-slate-600 dark:text-slate-400">
          已有账号？{" "}
          <Link href="/login" className="text-sky-600 dark:text-sky-400 hover:underline">
            登录
          </Link>
        </p>
      </div>
    </div>
  );
}
