import { loginRequest, validateStoredSession, type User } from "./api";

export type { User } from "./api";

export async function authenticate(
  username: string,
  password: string,
): Promise<{ token: string; user: User } | null> {
  try {
    const result = await loginRequest(username, password);
    return {
      token: result.token,
      user: result.user,
    };
  } catch (err) {
    // Let the UI show the API message (e.g. "Invalid credentials") instead of a silent failure.
    if (err instanceof Error) {
      throw err;
    }
    return null;
  }
}

export function getStoredToken(): string | null {
  return localStorage.getItem("dr_token");
}

export function storeToken(token: string): void {
  localStorage.setItem("dr_token", token);
}

export function storeUser(user: User): void {
  localStorage.setItem("dr_user", JSON.stringify(user));
}

export function getStoredUser(): User | null {
  const raw = localStorage.getItem("dr_user");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as User;
  } catch {
    return null;
  }
}

export function clearToken(): void {
  localStorage.removeItem("dr_token");
  localStorage.removeItem("dr_user");
}

export async function isAuthenticated(): Promise<boolean> {
  const token = getStoredToken();
  if (!token) return false;
  return validateStoredSession(token);
}
