// A channel's signature (#1190): the block a business ends its posts with (hotline, address, shop link, brand hashtags).
// The channel keeps one (crove_social.channel_policy.signature); a channel added to a post copies it into the variant's
// settings.signature, so a later change of the channel's never alters a post already written or approved. The one
// content resolver (effectiveContent) appends it to the text, so the hash, the checks, the previews and the publish all
// see the text that is sent. settings.signature false: left off this post on purpose (the composer's "Bỏ chữ ký").
export const SIGNATURE_MAX = 500;

// The signature in a variant's settings: { text } to append, 'off' when left off (false), null when there is none (a
// post from before signatures, or a channel without one), 'invalid' when the value is neither a text of 1 to
// SIGNATURE_MAX characters nor false.
export type SignatureSetting = { text: string } | 'off' | 'invalid' | null;

export function signatureOf(settings: Readonly<Record<string, unknown>> | null | undefined): SignatureSetting {
  const value = settings?.signature;
  if (value === undefined || value === null) return null;
  if (value === false) return 'off';
  if (typeof value !== 'string') return 'invalid';
  const text = value.trim();
  if (text === '' || [...text].length > SIGNATURE_MAX) return 'invalid';
  return { text };
}

// The signature a variant appends: its text, or null when it has none, left it off or holds an invalid one (which
// validateVariant flags).
export function signatureText(settings: Readonly<Record<string, unknown>> | null | undefined): string | null {
  const signature = signatureOf(settings);
  return signature !== null && typeof signature === 'object' ? signature.text : null;
}

// The text with the variant's signature after a blank line, unless the text already ends with it (a member who pasted
// it by hand, or a text kept with it). No signature, or one left off, leaves the text exactly as it is.
export function withSignature(body: string, settings: Readonly<Record<string, unknown>> | null | undefined): string {
  const signature = signatureText(settings);
  if (signature === null) return body;
  // trimEnd, not a /\s+$/ regex: linear on a long run of white space inside the text.
  const text = body.trimEnd();
  if (text.normalize('NFC').endsWith(signature.normalize('NFC'))) return body;
  return text === '' ? signature : `${text}\n\n${signature}`;
}

// The settings of a variant a channel is added with: the channel's signature copied in, unless the settings say
// already (a signature of their own, or false). A channel without one adds nothing, so its posts hash as before.
export function withChannelSignature<T extends Readonly<Record<string, unknown>>>(settings: T, signature: string | null | undefined): T | (T & { signature: string }) {
  if (!signature || Object.prototype.hasOwnProperty.call(settings, 'signature')) return settings;
  return { ...settings, signature };
}
