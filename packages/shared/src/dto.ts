import type { Role } from "./enums.js";

export interface UserDto {
  id: string;
  email: string;
  name: string;
  role: Role;
  disabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface MeResponse {
  user: UserDto;
  csrfToken: string;
}

export interface SetupStatus {
  needed: boolean;
}

export interface HealthResponse {
  ok: boolean;
  version: string;
}

export type ReadyState = "ok" | "degraded" | "failed";

export interface ReadyResponse {
  status: ReadyState;
  checks: { postgres: boolean; redis: boolean; ollama: boolean };
}

export interface ApiError {
  error: string;
  message: string;
  details?: unknown;
}
