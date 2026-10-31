import { Injectable, OnModuleInit } from '@nestjs/common';
import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { AuthFlow, ChallengeStore } from '../core/auth-flow.ts';
import { LicensingService } from '../licensing/licensing.service';
import { PgAuthRepo } from './pg-auth.repo';

/**
 * Schlüssel für die Access-Tokens dieses Kundenservers.
 * Wird bei der ersten Inbetriebnahme erzeugt und bleibt auf dem Server (STORE_JWT_KEY_FILE).
 */
function loadOrCreateJwtKey(path: string): { privateKey: KeyObject; publicKey: KeyObject } {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    const { privateKey } = generateKeyPairSync('ed25519');
    writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  }
  const privateKey = createPrivateKey(readFileSync(path, 'utf8'));
  return { privateKey, publicKey: createPublicKey(privateKey) };
}

/** Bündelt Login-Ablauf, Challenge-Speicher und JWT-Schlüssel für Controller, Guard und WebSocket. */
@Injectable()
export class AuthFlowProvider implements OnModuleInit {
  readonly challenges = new ChallengeStore(60);
  readonly jwt = loadOrCreateJwtKey(process.env.STORE_JWT_KEY_FILE ?? 'keys/store-jwt.key');
  flow!: AuthFlow;

  constructor(private readonly repo: PgAuthRepo, private readonly licensing: LicensingService) {}

  async onModuleInit() {
    await this.licensing.ready;
    this.flow = new AuthFlow({
      repo: this.repo,
      gate: this.licensing.gate,
      challenges: this.challenges,
      licensePublicKey: this.licensing.licensePublicKey,
      installationId: this.licensing.installationId,
      jwtKey: this.jwt.privateKey,
    });
  }
}
