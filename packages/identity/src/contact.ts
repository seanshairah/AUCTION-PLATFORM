/**
 * Phone numbers and email addresses as people type them, normalised for storage
 * and comparison (docs/16 §9). Phones become E.164. A Zimbabwe number typed the
 * local way ("077 123 4567") becomes +263771234567 (assumption A47).
 */

export type Contact = { type: 'phone'; value: string } | { type: 'email'; value: string };

export type ContactError = 'invalid_contact' | 'not_a_mobile';

const ZW = '263';
/** Zimbabwe mobile prefixes after +263: 71 NetOne, 73 Telecel, 77 and 78 Econet. */
const ZW_MOBILE = /^\+2637[1378]\d{7}$/;

export function normalisePhone(input: string): string | null {
  let d = input.trim().replace(/[\s().-]/g, '');
  if (d.startsWith('00')) d = `+${d.slice(2)}`;
  if (d.startsWith('+')) {
    if (!/^\+\d+$/.test(d)) return null;
    // "+263 077..." is a common slip: drop the trunk zero.
    if (d.startsWith(`+${ZW}0`)) d = `+${ZW}${d.slice(5)}`;
  } else {
    if (!/^\d+$/.test(d)) return null;
    if (d.startsWith(ZW) && d.length === 12) d = `+${d}`;
    else if (d.startsWith('0') && d.length === 10) d = `+${ZW}${d.slice(1)}`;
    else if (d.length === 9 && d.startsWith('7')) d = `+${ZW}${d}`;
    else return null;
  }
  if (d.startsWith(`+${ZW}`)) return /^\+263[1-9]\d{8}$/.test(d) ? d : null;
  return /^\+[1-9]\d{7,14}$/.test(d) ? d : null;
}

export function isZimbabweMobile(e164: string): boolean {
  return ZW_MOBILE.test(e164);
}

export function normaliseEmail(input: string): string | null {
  const e = input.trim().toLowerCase();
  if (e.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return null;
  return e;
}

/**
 * Reads what someone typed into the sign-in box. Zimbabwe numbers must be mobiles,
 * because a code cannot be sent to a landline.
 */
export function parseContact(input: string): Contact | ContactError {
  if (input.includes('@')) {
    const email = normaliseEmail(input);
    return email ? { type: 'email', value: email } : 'invalid_contact';
  }
  const phone = normalisePhone(input);
  if (!phone) return 'invalid_contact';
  if (phone.startsWith(`+${ZW}`) && !isZimbabweMobile(phone)) return 'not_a_mobile';
  return { type: 'phone', value: phone };
}

/** "+26377•••••567", "f•••@example.com": enough to recognise, not enough to harvest. */
export function maskContact(c: Contact): string {
  if (c.type === 'phone') return `${c.value.slice(0, 6)}${'•'.repeat(Math.max(0, c.value.length - 9))}${c.value.slice(-3)}`;
  const [user, domain] = c.value.split('@') as [string, string];
  return `${user.slice(0, 1)}•••@${domain}`;
}
