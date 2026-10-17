// Reads the emails Supabase Auth sent through the stack's Mailpit (http://localhost:8025).
import { expect } from '@playwright/test';

export const MAILPIT_URL = process.env.E2E_MAILPIT_URL ?? 'http://localhost:8025';

interface Summary {
  ID: string;
  Subject: string;
}

async function json<T>(path: string): Promise<T> {
  const response = await fetch(`${MAILPIT_URL}${path}`);
  if (!response.ok) throw new Error(`Mailpit ${path}: ${response.status}`);
  return (await response.json()) as T;
}

// Waits for the newest email to `to` whose subject matches, and returns the Supabase Auth link in it.
export async function authLink(to: string, subject: RegExp): Promise<string> {
  let link = '';
  await expect
    .poll(
      async () => {
        const { messages } = await json<{ messages: Summary[] }>(`/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
        const message = messages.find((m) => subject.test(m.Subject));
        if (!message) return '';
        const { HTML } = await json<{ HTML: string }>(`/api/v1/message/${message.ID}`);
        link = /href="([^"]*\/verify\?[^"]*)"/.exec(HTML)?.[1]?.replaceAll('&amp;', '&') ?? '';
        return link;
      },
      { message: `email to ${to} matching ${subject}`, timeout: 30_000 },
    )
    .not.toBe('');
  return link;
}
