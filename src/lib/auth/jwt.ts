import { SignJWT, jwtVerify } from "jose";

export const SESSION_COOKIE_NAME = "wealth_session";

function encoderSecret(): Uint8Array {
  const s = process.env.AUTH_SECRET?.trim();
  if (!s) throw new Error("AUTH_SECRET");
  return new TextEncoder().encode(s);
}

export async function signSessionToken(userId: string): Promise<string> {
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(encoderSecret());
}

/** Edge / middleware：不因缺密钥抛异常 */
export async function verifySessionToken(token: string): Promise<string | null> {
  const s = process.env.AUTH_SECRET?.trim();
  if (!s) return null;
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(s));
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}
