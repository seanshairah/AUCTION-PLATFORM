/**
 * Template rendering (docs/16 §3). Pure. Placeholders are {{name}}. A placeholder
 * with no value is an error, never a blank: a message that says "Invoice  is due"
 * is worse than no message.
 */

const PLACEHOLDER = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;

export class MissingParamError extends Error {
  constructor(
    readonly templateKey: string,
    readonly missing: string[],
  ) {
    super(`Template ${templateKey} is missing ${missing.join(', ')}`);
    this.name = 'MissingParamError';
  }
}

export class MessageTooLongError extends Error {
  constructor(
    readonly templateKey: string,
    readonly length: number,
    readonly limit: number,
  ) {
    super(`Template ${templateKey} renders to ${length} characters; the limit is ${limit}`);
    this.name = 'MessageTooLongError';
  }
}

/** Placeholder names in order of first appearance (the order of WhatsApp's {{1}}, {{2}}, ...). */
export function placeholders(body: string): string[] {
  const seen: string[] = [];
  for (const m of body.matchAll(PLACEHOLDER)) if (!seen.includes(m[1]!)) seen.push(m[1]!);
  return seen;
}

export function render(body: string, params: Readonly<Record<string, string>>, templateKey = 'template'): string {
  const missing = placeholders(body).filter((p) => typeof params[p] !== 'string' || params[p]!.trim() === '');
  if (missing.length) throw new MissingParamError(templateKey, missing);
  return body.replace(PLACEHOLDER, (_, name: string) => params[name]!);
}

/** The body as Meta wants it for template approval: named placeholders become {{1}}, {{2}}, ... */
export function metaTemplateBody(body: string): string {
  const order = placeholders(body);
  return body.replace(PLACEHOLDER, (_, name: string) => `{{${order.indexOf(name) + 1}}}`);
}

// --- SMS: GSM 03.38 ----------------------------------------------------------------------

const GSM_BASIC = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM_EXTENSION = '^{}\\[~]|€';
const GSM = new Set([...GSM_BASIC, ...GSM_EXTENSION]);
export const SMS_LIMIT = 160;

/** Same character set as the database's comms.is_gsm7(). */
export function isGsm7(text: string): boolean {
  return [...text].every((ch) => GSM.has(ch));
}

/** Length in GSM septets: extension characters take two. */
export function gsmLength(text: string): number {
  return [...text].reduce((n, ch) => n + (GSM_EXTENSION.includes(ch) ? 2 : 1), 0);
}

const LOOKALIKE: Record<string, string> = {
  '‘': "'", '’': "'", '‚': "'", '′': "'", '“': '"', '”': '"', '„': '"', '″': '"',
  '–': '-', '—': '-', '‒': '-', '−': '-', '…': '...', ' ': ' ', ' ': ' ', ' ': ' ',
  '•': '-', '×': 'x',
};

/** Makes a value safe for one GSM-7 SMS: common look-alikes replaced, anything else becomes '?'. */
export function gsmSafe(value: string): string {
  return [...value]
    .map((ch) => {
      if (GSM.has(ch)) return ch;
      const alt = LOOKALIKE[ch] ?? ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
      return alt !== '' && isGsm7(alt) ? alt : '?';
    })
    .join('');
}

/** Free-text values that may be shortened to fit an SMS. Links, codes, amounts and dates never are. */
const SHORTENABLE = new Set(['lot', 'title', 'auction', 'branch', 'step', 'reason']);

/**
 * Renders one SMS: values made GSM-safe, and if the result is over 160 characters
 * the longest free-text value (usually a lot title) is shortened with "...".
 * If that is not enough, the message is refused rather than cut mid-link.
 */
export function renderSms(body: string, params: Readonly<Record<string, string>>, templateKey = 'template'): string {
  const safe: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) safe[k] = gsmSafe(v);
  let text = render(body, safe, templateKey);
  const names = placeholders(body).filter((n) => SHORTENABLE.has(n));
  while (gsmLength(text) > SMS_LIMIT) {
    const longest = names.reduce<string | null>((a, n) => (a === null || safe[n]!.length > safe[a]!.length ? n : a), null);
    if (!longest || safe[longest]!.length <= 8) throw new MessageTooLongError(templateKey, gsmLength(text), SMS_LIMIT);
    const over = gsmLength(text) - SMS_LIMIT;
    safe[longest] = `${safe[longest]!.slice(0, Math.max(5, safe[longest]!.length - over - 3)).trimEnd()}...`;
    text = render(body, safe, templateKey);
  }
  return text;
}
