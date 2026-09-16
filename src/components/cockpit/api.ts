/** Navigation and the request helpers every cockpit page uses. */
import { reportLearningError } from "@/lib/cockpit/learning";

export const navigate = (path: string) => {
  history.pushState({}, "", path);
  dispatchEvent(new PopStateEvent("popstate"));
};
export const e2eTestUserId = () =>
  (globalThis as typeof globalThis & { __WATTR_E2E_USER_ID__?: string }).__WATTR_E2E_USER_ID__;

/** Sent after a model is published or restored, so every page reads the version Operations now runs. */
export const FACILITIES_CHANGED = "wattr:facilities-changed";

/** Sent after the signed-in person takes another role, so the whole session is re-read. */
export const SESSION_CHANGED = "wattr:session-changed";

/** Forget the development sign-in, if one was set on this page. */
export function clearTestIdentity() {
  delete (globalThis as typeof globalThis & { __WATTR_E2E_USER_ID__?: string }).__WATTR_E2E_USER_ID__;
}

export class ApiError extends Error {
  status: number;
  body: Record<string, any>;
  constructor(message: string, status: number, body: Record<string, any>) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const testUserId = e2eTestUserId();
  if (testUserId) headers.set("x-test-user-id", testUserId);
  const response = await fetch(path, { ...init, headers });
  // An HTML page where data was expected means this server has no such route.
  if (response.ok && (response.headers.get("content-type") ?? "").includes("text/html")) {
    throw new ApiError("The server returned a page instead of data", response.status, {});
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (!path.startsWith("/api/learning/")) {
      const category = response.status === 401 || response.status === 403 || response.status === 404
        ? "PERMISSION_FAILURE"
        : response.status === 502 || response.status === 503 || response.status === 504
          ? "EXTERNAL_SERVICE_UNAVAILABLE"
          : "APPLICATION_FAULT";
      reportLearningError(category, `HTTP_${response.status}`, { route: location.pathname });
    }
    throw new ApiError(body.error || `Request failed (${response.status})`, response.status, body);
  }
  return body as T;
}
export const post = <T,>(path: string, body: unknown) => api<T>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
export const patch = <T,>(path: string, body: unknown) => api<T>(path, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
export const remove = (path: string) => api<void>(path, { method: "DELETE" });

/**
 * A sentence to show when a request fails: what happened and what to do next,
 * rather than a raw status line such as "Error: Request failed (401)".
 */
export function describeError(cause: unknown): string {
  const status = cause instanceof Error && "status" in cause && typeof cause.status === "number" ? cause.status : undefined;
  if (status === 401) return "Your session has ended. Sign in again to continue.";
  if (status === 403) return "Your account does not have access to this. Ask an administrator if you need it.";
  if (status !== undefined && status >= 500) return "Wattr hit a problem on the server. Try again in a moment.";
  if (cause instanceof TypeError && /fetch|network|load failed/i.test(cause.message)) {
    return "Wattr could not reach the server. Check your connection and try again.";
  }
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
