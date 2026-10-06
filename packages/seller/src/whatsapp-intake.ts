import { formatMinor, parseAmountInput, type Currency } from '@abc/domain';
import type { RuleSnapshot } from '@abc/rules';

/**
 * Seller intake over WhatsApp (blueprint module 9: "Intake by app or WhatsApp";
 * §7: "WhatsApp is where people read messages"). A pure conversation state machine:
 * each incoming message moves the conversation on and returns the reply to send.
 * The communications layer (deliverable 16) carries the messages; this decides them.
 * The result is a draft lot that intake staff review; nothing goes live from chat.
 */

export interface IntakeOptions {
  categories: ReadonlyArray<{ code: string; name: string }>;
  conditions: ReadonlyArray<{ code: string; label: string }>;
  snapshot: RuleSnapshot;
}

export interface IntakeDraft {
  category?: string;
  title?: string;
  condition?: string;
  photoIds: string[];
  reserve?: { currency: Currency; minor: bigint } | null;
}

export type IntakeStep = 'category' | 'title' | 'condition' | 'photos' | 'reserve' | 'confirm' | 'done' | 'cancelled';

export interface IntakeState {
  step: IntakeStep;
  draft: IntakeDraft;
}

export interface IncomingMessage {
  text?: string;
  imageIds?: string[];
}

export function startIntake(opts: IntakeOptions): { state: IntakeState; reply: string } {
  return {
    state: { step: 'category', draft: { photoIds: [] } },
    reply:
      'Welcome to ABC Auctions selling. What are you selling? Reply with a number:\n' +
      opts.categories.map((c, i) => `${i + 1}. ${c.name}`).join('\n') +
      '\nReply STOP at any time to cancel.',
  };
}

function choose<T>(text: string, options: readonly T[]): T | undefined {
  const n = Number(text.trim());
  return Number.isInteger(n) && n >= 1 && n <= options.length ? options[n - 1] : undefined;
}

function parseReserve(text: string): { currency: Currency; minor: bigint } | null | 'invalid' {
  const t = text.trim();
  if (/^(none|no|0)$/i.test(t)) return null;
  const currency: Currency = /zig|zwg/i.test(t) ? 'ZWG' : 'USD';
  const parsed = parseAmountInput(t);
  if (!parsed.ok || parsed.minor <= 0n) return 'invalid';
  return { currency, minor: parsed.minor };
}

function minPhotos(draft: IntakeDraft, opts: IntakeOptions): number {
  return opts.snapshot.get('catalogue.min_photos', { categoryPath: draft.category ? [draft.category] : [] });
}

export function handleIntakeMessage(state: IntakeState, msg: IncomingMessage, opts: IntakeOptions): { state: IntakeState; reply: string } {
  const text = (msg.text ?? '').trim();
  if (/^stop$/i.test(text)) return { state: { ...state, step: 'cancelled' }, reply: 'Cancelled. Nothing was saved. Message us any time to start again.' };
  const draft = { ...state.draft, photoIds: [...state.draft.photoIds] };

  switch (state.step) {
    case 'category': {
      const c = choose(text, opts.categories);
      if (!c) return { state, reply: `Please reply with a number from 1 to ${opts.categories.length}.` };
      draft.category = c.code;
      return { state: { step: 'title', draft }, reply: `${c.name}. In a few words, what is it? For example: "Samsung 55-inch TV" or "Toyota Hilux 2019".` };
    }
    case 'title': {
      if (text.length < 5) return { state, reply: 'Please describe it in at least 5 characters.' };
      draft.title = text;
      return {
        state: { step: 'condition', draft },
        reply: 'What condition is it in? Reply with a number:\n' + opts.conditions.map((c, i) => `${i + 1}. ${c.label}`).join('\n'),
      };
    }
    case 'condition': {
      const c = choose(text, opts.conditions);
      if (!c) return { state, reply: `Please reply with a number from 1 to ${opts.conditions.length}.` };
      draft.condition = c.code;
      const n = minPhotos(draft, opts);
      return { state: { step: 'photos', draft }, reply: `Please send at least ${n} clear photos, including the whole item and any label or serial number. Reply DONE when finished.` };
    }
    case 'photos': {
      if (msg.imageIds?.length) draft.photoIds.push(...msg.imageIds);
      const n = minPhotos(draft, opts);
      if (/^done$/i.test(text)) {
        if (draft.photoIds.length < n) return { state: { step: 'photos', draft }, reply: `We have ${draft.photoIds.length} photos; please send at least ${n - draft.photoIds.length} more.` };
        return {
          state: { step: 'reserve', draft },
          reply: 'Do you want a reserve (the lowest price you will accept)? Reply with an amount, e.g. "300" for US$300 or "ZiG 5000", or reply NONE.',
        };
      }
      return { state: { step: 'photos', draft }, reply: `Got it: ${draft.photoIds.length} photo${draft.photoIds.length === 1 ? '' : 's'} so far. Reply DONE when finished.` };
    }
    case 'reserve': {
      const r = parseReserve(text);
      if (r === 'invalid') return { state, reply: 'Please reply with an amount, such as 300 or ZiG 5000, or NONE.' };
      draft.reserve = r;
      const cat = opts.categories.find((c) => c.code === draft.category)?.name ?? draft.category;
      const cond = opts.conditions.find((c) => c.code === draft.condition)?.label ?? draft.condition;
      return {
        state: { step: 'confirm', draft },
        reply:
          `Please check:\n${draft.title}\n${cat} · ${cond}\n${draft.photoIds.length} photos\nReserve: ${r === null ? 'none' : formatMinor(r.minor, r.currency)}\n` +
          'Reply YES to send this to our intake team, or NO to start again.',
      };
    }
    case 'confirm': {
      if (/^yes$/i.test(text)) {
        return {
          state: { step: 'done', draft },
          reply: 'Thank you. Our intake team will check the details and send you a valuation range and your consignment note to sign in the app.',
        };
      }
      if (/^no$/i.test(text)) return startIntake(opts);
      return { state, reply: 'Please reply YES or NO.' };
    }
    default:
      return { state, reply: 'This conversation has ended. Message us any time to start again.' };
  }
}
