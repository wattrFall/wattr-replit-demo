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
