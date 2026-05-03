import bcrypt from "bcryptjs";

const PASSWORD_ROUNDS = 10;
const RESET_CODE_ROUNDS = 8;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, PASSWORD_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export async function hashResetCode(code: string): Promise<string> {
  return bcrypt.hash(code, RESET_CODE_ROUNDS);
}

export async function verifyResetCode(code: string, hash: string): Promise<boolean> {
  return bcrypt.compare(code, hash);
}
