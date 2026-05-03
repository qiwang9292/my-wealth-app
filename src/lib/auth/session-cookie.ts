import { NextResponse } from "next/server";
import { SESSION_COOKIE_NAME } from "@/lib/auth/jwt";

const WEEK_SEC = 60 * 60 * 24 * 7;

const base = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
};

export function setSessionCookie(res: NextResponse, token: string) {
  res.cookies.set(SESSION_COOKIE_NAME, token, {
    ...base,
    maxAge: WEEK_SEC,
  });
}

export function clearSessionCookie(res: NextResponse) {
  res.cookies.set(SESSION_COOKIE_NAME, "", {
    ...base,
    maxAge: 0,
  });
}
