import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ServerConfig } from './config';
import type { Logger } from './log';

/**
 * Sign-in code delivery over HTTPS email APIs (Railway blocks outbound SMTP below the Pro plan,
 * and recommends an API such as Resend). `log` writes the code to the service's private logs
 * for development and staging checks; production refuses it at boot (config.ts).
 */
export interface CodeEmail {
  to: string;
  code: string;
  ttlMinutes: number;
}

export interface Mailer {
  sendCode(message: CodeEmail): Promise<void>;
}

export class MailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailError';
  }
}

type Fetch = typeof fetch;

const SUBJECT = 'Your PaceLeague sign-in code';

function textBody({ code, ttlMinutes }: CodeEmail): string {
  return `Your PaceLeague sign-in code is ${code}.\n\nEnter it in the app. It expires in ${ttlMinutes} minutes and works once.\n\nIf you didn't ask to sign in, you can ignore this email.\n`;
}

function htmlBody(template: string | null, message: CodeEmail): string {
  if (!template) return `<p>Your PaceLeague sign-in code is <strong>${message.code}</strong>.</p><p>It expires in ${message.ttlMinutes} minutes and works once.</p>`;
  return template.replace(/\{\{\s*\.Token\s*\}\}/g, message.code).replace(/10 minutes/g, `${message.ttlMinutes} minutes`);
}

export function loadCodeTemplate(dbDir: string): string | null {
  const path = join(dbDir, 'templates', 'sign-in-code.html');
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/** "alex@demo.test" → "a***@demo.test": enough to tell test accounts apart in logs. */
export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}***@${domain}`;
}

async function post(fetchImpl: Fetch, url: string, headers: Record<string, string>, body: unknown, provider: string): Promise<void> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new MailError(`${provider} request failed: ${error instanceof Error ? error.name : 'error'}`);
  }
  if (!response.ok) {
    // Never echo the response body: providers can include the recipient or key details.
    throw new MailError(`${provider} rejected the message (HTTP ${response.status})`);
  }
}

export interface MemoryMailer extends Mailer {
  sent: CodeEmail[];
}

export function createMemoryMailer(): MemoryMailer {
  const sent: CodeEmail[] = [];
  return { sent, sendCode: async (message) => void sent.push(message) };
}

export function createMailer(config: Pick<ServerConfig, 'email'>, log: Logger, template: string | null, fetchImpl: Fetch = fetch): Mailer {
  const { provider, apiKey, from, replyTo } = config.email;
  switch (provider) {
    case 'resend':
      return {
        sendCode: (message) =>
          post(
            fetchImpl,
            'https://api.resend.com/emails',
            { authorization: `Bearer ${apiKey}` },
            { from, to: [message.to], subject: SUBJECT, html: htmlBody(template, message), text: textBody(message), ...(replyTo ? { reply_to: replyTo } : {}) },
            'Resend',
          ),
      };
    case 'postmark':
      return {
        sendCode: (message) =>
          post(
            fetchImpl,
            'https://api.postmarkapp.com/email',
            { 'x-postmark-server-token': apiKey ?? '' },
            {
              From: from,
              To: message.to,
              Subject: SUBJECT,
              HtmlBody: htmlBody(template, message),
              TextBody: textBody(message),
              MessageStream: 'outbound',
              ...(replyTo ? { ReplyTo: replyTo } : {}),
            },
            'Postmark',
          ),
      };
    case 'memory':
      return createMemoryMailer();
    case 'log':
      return {
        sendCode: async (message) => {
          log.warn('sign-in code (EMAIL_PROVIDER=log: written to logs, not emailed)', { to: maskEmail(message.to), code: message.code });
        },
      };
  }
}
