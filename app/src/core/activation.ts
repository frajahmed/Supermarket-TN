export type ActivationStatus = 'pending' | 'approved' | 'rejected' | 'revoked';

/** Was nach einer Statusabfrage passiert: weiter warten, fertig (zur Anmeldung) oder abgebrochen. */
export type ActivationNext = 'wait' | 'done' | 'failed';

export function nextActivationStep(status: string, hasCertificate: boolean): ActivationNext {
  if (status === 'approved') return hasCertificate ? 'done' : 'wait';
  if (status === 'rejected' || status === 'revoked') return 'failed';
  return 'wait';
}

export function activationStatusKey(status: string): string {
  return ['pending', 'approved', 'rejected', 'revoked'].includes(status) ? `activation.${status}` : 'activation.pending';
}
