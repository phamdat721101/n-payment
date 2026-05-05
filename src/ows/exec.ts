import { execFile } from 'node:child_process';
import { NPaymentError } from '../errors.js';
import type { OWSExecResult } from './types.js';

const OWS_ERROR_MAP: Record<string, { code: string; hint: string }> = {
  'policy': { code: 'OWS_POLICY_DENIED', hint: 'Adjust spending limits in OWS policy' },
  'denied': { code: 'OWS_POLICY_DENIED', hint: 'Adjust spending limits in OWS policy' },
  'locked': { code: 'OWS_VAULT_LOCKED', hint: 'Unlock your OWS vault' },
  'decrypt': { code: 'OWS_VAULT_LOCKED', hint: 'Unlock your OWS vault' },
  'not found': { code: 'OWS_WALLET_NOT_FOUND', hint: 'Create wallet: ows wallet create --name <name>' },
  'insufficient': { code: 'INSUFFICIENT_BALANCE', hint: 'Fund wallet: ows fund deposit --wallet <name>' },
  'balance': { code: 'INSUFFICIENT_BALANCE', hint: 'Fund wallet: ows fund deposit --wallet <name>' },
};

export function owsExec(cliPath: string, args: string[]): Promise<OWSExecResult> {
  return new Promise((resolve, reject) => {
    execFile(cliPath, args, { timeout: 120_000 }, (err, stdout, stderr) => {
      if (!err) {
        try {
          const parsed = JSON.parse(stdout.trim());
          resolve(parsed.ok !== undefined ? parsed : { ok: true, data: parsed });
        } catch {
          resolve({ ok: true, data: stdout.trim() });
        }
        return;
      }

      const output = (stderr || stdout || err.message).toLowerCase();
      for (const [keyword, mapped] of Object.entries(OWS_ERROR_MAP)) {
        if (output.includes(keyword)) {
          reject(new NPaymentError(
            `OWS: ${(stderr || stdout || err.message).trim()}`,
            mapped.code,
            mapped.hint,
          ));
          return;
        }
      }

      reject(new NPaymentError(
        `OWS command failed: ${(stderr || stdout || err.message).trim()}`,
        'OWS_ERROR',
        'Check OWS installation and wallet configuration',
      ));
    });
  });
}
