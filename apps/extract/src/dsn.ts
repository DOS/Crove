// Delivery status notifications (RFC 3464, issue #539): the bounce report a mail server sends back to the Return-Path
// of a mail it could not deliver. Read here, in the parser process, like every inbound message. What leaves is the
// action and status code of each recipient and the Message-ID of the bounced mail; never an address, a diagnostic
// text or a body.
import type { Email } from 'postal-mime';
import { DSN_ACTIONS, EXTRACT_LIMITS, type ExtractedDsn } from '@crove/extract-contract';

export class DsnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DsnError';
  }
}

// A report is a few lines per recipient; anything longer is not read past this.
const MAX_REPORT_CHARS = 64 * 1024;
const STATUS = /^([245])\.(\d{1,3})\.(\d{1,3})\b/;
const MESSAGE_ID = /^message-id:[ \t]*(<[^<>\s]{3,253}>)/im;

function textOf(content: ArrayBuffer | Uint8Array | string): string {
  const text = typeof content === 'string' ? Buffer.from(content, 'base64').toString('utf8') : Buffer.from(content instanceof Uint8Array ? content : new Uint8Array(content)).toString('utf8');
  return text.slice(0, MAX_REPORT_CHARS);
}

// The fields of each block (RFC 822 style), header names in lower case, with folded lines joined.
function blocks(report: string): Array<Map<string, string>> {
  return report
    .replace(/\r\n/g, '\n')
    .split(/\n[ \t]*\n/)
    .map((block) => {
      const fields = new Map<string, string>();
      for (const line of block.replace(/\n[ \t]+/g, ' ').split('\n')) {
        const colon = line.indexOf(':');
        if (colon <= 0) continue;
        const name = line.slice(0, colon).trim().toLowerCase();
        if (!fields.has(name)) fields.set(name, line.slice(colon + 1).trim());
      }
      return fields;
    })
    .filter((fields) => fields.size > 0);
}

export function readDsn(email: Pick<Email, 'attachments'>): ExtractedDsn {
  const report = email.attachments.find((a) => a.mimeType === 'message/delivery-status' || a.mimeType === 'message/global-delivery-status');
  if (!report) throw new DsnError('Thư không phải báo cáo trạng thái gửi (DSN)');
  const recipients: ExtractedDsn['recipients'] = [];
  // The first block is about the report itself; each one after it is about one recipient.
  for (const fields of blocks(textOf(report.content)).slice(1)) {
    const action = fields.get('action')?.split(/[\s(;]/)[0]?.toLowerCase();
    if (!action || !(DSN_ACTIONS as readonly string[]).includes(action)) continue;
    const status = STATUS.exec(fields.get('status') ?? '');
    recipients.push({ action: action as ExtractedDsn['recipients'][number]['action'], status: status ? `${status[1]}.${status[2]}.${status[3]}` : null });
    if (recipients.length >= EXTRACT_LIMITS.maxDsnRecipients) break;
  }
  if (recipients.length === 0) throw new DsnError('Báo cáo trạng thái gửi không có người nhận nào');
  // The bounced mail's headers, when the report quotes them (text/rfc822-headers, or the whole mail).
  const quoted = email.attachments.find((a) => a.mimeType === 'text/rfc822-headers' || a.mimeType === 'message/rfc822' || a.mimeType === 'message/global-headers');
  const id = quoted ? MESSAGE_ID.exec(textOf(quoted.content))?.[1] : undefined;
  return { originalMessageId: id ?? null, recipients };
}
