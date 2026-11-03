import { DeviceIdentity } from '../core/identity';
import { deviceProof } from '../device/runtime';

interface FetchLike {
  (input: string, init?: RequestInit): Promise<Response>;
}

export interface SetupInfo {
  installationId: string;
  licenseServerUrl: string;
}

export interface ActivationRequest {
  requestId: string;
  activationCode: string;
  status: 'pending' | 'approved' | 'rejected' | 'revoked';
}

export interface LoginCredentials {
  email: string;
  password?: string;
  pin?: string;
  totp?: string;
}

function url(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/u, '')}${path}`;
}

/** Fehler mit HTTP-Status und Servermeldung, damit Bildschirme passend reagieren können (401, 423 …). */
export class ServerError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { message?: unknown };
    throw new ServerError(response.status, typeof body.message === 'string' ? body.message : `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export class CustomerServerClient {
  private readonly fetchImpl: FetchLike;

  constructor(private readonly baseUrl: string, fetchImpl: FetchLike = fetch) {
    this.fetchImpl = fetchImpl;
  }

  async setupInfo(): Promise<SetupInfo> {
    return json<SetupInfo>(await this.fetchImpl(url(this.baseUrl, '/api/v1/setup/info')));
  }

  async requestActivation(
    licenseServerUrl: string, installationId: string, identity: DeviceIdentity, name: string,
    kind: 'phone' | 'scanner' | 'tablet' | 'pos' = 'phone',
  ): Promise<ActivationRequest> {
    return json<ActivationRequest>(await this.fetchImpl(url(licenseServerUrl, '/v1/activation-requests'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ installationId, name, kind, publicKey: identity.publicKey }),
    }));
  }

  async activationStatus(licenseServerUrl: string, requestId: string): Promise<{ status: string; certificate?: string }> {
    return json<{ status: string; certificate?: string }>(
      await this.fetchImpl(url(licenseServerUrl, `/v1/activation-requests/${requestId}`)),
    );
  }

  async login(identity: DeviceIdentity, credentials: LoginCredentials): Promise<unknown> {
    const challenge = await json<{ challenge: string }>(await this.fetchImpl(url(this.baseUrl, '/api/v1/auth/challenge'), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }));
    const proof = await deviceProof(identity, challenge.challenge);
    return json<unknown>(await this.fetchImpl(url(this.baseUrl, '/api/v1/auth/login'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...credentials, device: proof }),
    }));
  }

  async licenseStatus(accessToken: string): Promise<unknown> {
    return json<unknown>(await this.fetchImpl(url(this.baseUrl, '/api/v1/license/status'), {
      headers: { authorization: `Bearer ${accessToken}` },
    }));
  }
}
