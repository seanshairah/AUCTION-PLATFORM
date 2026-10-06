import { run, type Queryable } from '@abc/db';

/**
 * Staff authorisation (docs/18-admin-operations.md §3). Roles come from
 * identity.staff_role; each console action names one permission, and the matrix
 * below says which roles hold it. Least privilege: an action not listed for a role
 * is refused. The auditor role reads everything and changes nothing (PROPOSED, A57).
 */

export const STAFF_ROLES = ['ops', 'finance', 'risk', 'support', 'cashier', 'vehicle_desk', 'admin', 'auditor'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export interface StaffMember {
  id: string;
  name: string;
  roles: StaffRole[];
}

const ALL: readonly StaffRole[] = STAFF_ROLES;
const READERS: readonly StaffRole[] = ['ops', 'finance', 'risk', 'support', 'admin', 'auditor'];

/** Permission → roles that hold it. The single source for the console and the API. */
export const PERMISSIONS = {
  'dashboard.view': ALL,
  'override.view': READERS,
  'override.limit_change.request': ['risk', 'admin'],
  'override.limit_change.approve': ['risk', 'finance', 'admin'],
  'override.tier_change.request': ['risk', 'admin'],
  'override.tier_change.approve': ['risk', 'admin'],
  'tax_rate.view': ['finance', 'admin', 'auditor'],
  'tax_rate.activation.request': ['finance'],
  'tax_rate.activation.approve': ['finance'],
  'rulebook.view': ['ops', 'finance', 'risk', 'admin', 'auditor'],
  // Acknowledging and approving also needs the owning role of every changed rule, or admin (docs/03 §6).
  'rulebook.approve': ['ops', 'finance', 'risk', 'admin'],
  'risk.view': ['risk', 'admin', 'auditor'],
  'risk.decide_registration': ['risk', 'admin'],
  'reconciliation.view': ['finance', 'admin', 'auditor'],
  'reconciliation.resolve': ['finance'],
  'reconciliation.write_off.request': ['finance'],
  'reconciliation.write_off.approve': ['finance', 'admin'],
  'default.view': ['risk', 'finance', 'support', 'admin', 'auditor'],
  'default.appeal.record': ['support', 'risk'],
  'default.appeal.decide': ['risk', 'admin'],
  'default.waiver.request': ['risk', 'finance', 'admin'],
  'default.waiver.approve': ['risk', 'finance', 'admin'],
  'auction.schedule': ['ops', 'admin'],
  'analytics.view': ['ops', 'finance', 'risk', 'admin', 'auditor'],
  'analytics.baseline.freeze': ['finance', 'admin'],
} as const satisfies Record<string, readonly StaffRole[]>;

export type Permission = keyof typeof PERMISSIONS;

export class AdminError extends Error {
  constructor(
    readonly code: 'forbidden' | 'not_found' | 'conflict' | 'invalid',
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AdminError';
  }
}

export function can(staff: Pick<StaffMember, 'roles'>, permission: Permission): boolean {
  const allowed = PERMISSIONS[permission] as readonly StaffRole[];
  return staff.roles.some((r) => allowed.includes(r));
}

export function requirePermission(staff: Pick<StaffMember, 'roles'>, permission: Permission): void {
  if (!can(staff, permission)) {
    const roles = (PERMISSIONS[permission] as readonly StaffRole[]).join(', ');
    throw new AdminError('forbidden', `Your role cannot do this. It needs one of: ${roles}.`, { permission });
  }
}

/** The staff member behind an account, or null if the account holds no staff role. */
export async function loadStaff(q: Queryable, accountId: string): Promise<StaffMember | null> {
  const r = await run<{ display_name: string; roles: StaffRole[] | null }>(
    q,
    `SELECT a.display_name, array_agg(s.role ORDER BY s.role) FILTER (WHERE s.role IS NOT NULL) AS roles
       FROM identity.account a LEFT JOIN identity.staff_role s ON s.account_id = a.id
      WHERE a.id = $1 AND a.status = 'active'
      GROUP BY a.display_name`,
    [accountId],
  );
  const row = r.rows[0];
  if (!row || !row.roles || row.roles.length === 0) return null;
  return { id: accountId, name: row.display_name, roles: row.roles };
}

/** The audit actor for a staff member's action, carrying the reason into audit.event (R3). */
export function staffActor(staff: StaffMember, reason: string, requestId?: string) {
  return { type: 'staff' as const, id: staff.id, name: staff.name, reason, ...(requestId ? { requestId } : {}) };
}

/** A reason staff must give: plain words, at least ten characters (matches the database checks). */
export function requireReason(reason: unknown, what = 'a reason'): string {
  if (typeof reason !== 'string' || reason.trim().length < 10) {
    throw new AdminError('invalid', `Give ${what} of at least 10 characters.`);
  }
  return reason.trim();
}
