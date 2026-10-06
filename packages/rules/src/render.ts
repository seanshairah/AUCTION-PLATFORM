import { RULES, SECTIONS, type RenderContext, type RuleKey, type Section } from './registry';
import type { RuleSnapshot } from './resolve';
import type { Provenance, RuleScope } from './types';

/**
 * Renders the public rulebook from a snapshot: the one source the app, the website,
 * WhatsApp help replies and the help desk all show (blueprint principle 10).
 */

export interface RenderedRule {
  key: RuleKey;
  title: string;
  text: string;
  provenance: Provenance;
  /** Category, tier or other overrides of the default, each in plain language. */
  overrides: Array<{ scope: RuleScope; text: string }>;
}

export interface RenderedRulebook {
  versionLabel: string;
  sections: Array<{ section: Section; rules: RenderedRule[] }>;
}

/** Rules that only make sense when another rule is switched on. */
const SHOWN_ONLY_WHEN: Partial<Record<RuleKey, RuleKey>> = {
  'storage.free_hours': 'storage.enabled',
  'storage.daily_rate_bp': 'storage.enabled',
};

const DEFAULT_CONTEXT: RenderContext = {
  categoryName: (code) => code.charAt(0).toUpperCase() + code.slice(1).replaceAll('_', ' '),
};

export function renderRulebook(
  snapshot: RuleSnapshot,
  options: { includeInternal?: boolean; context?: Partial<RenderContext> } = {},
): RenderedRulebook {
  const ctx: RenderContext = { ...DEFAULT_CONTEXT, ...options.context };
  const sections = SECTIONS.map((section) => {
    const rules: RenderedRule[] = [];
    for (const key of Object.keys(RULES) as RuleKey[]) {
      const def = RULES[key];
      if (def.section !== section) continue;
      if (!def.public && !options.includeInternal) continue;
      const dependsOn = SHOWN_ONLY_WHEN[key];
      if (dependsOn && snapshot.get(dependsOn) !== true && !options.includeInternal) continue;
      const resolved = snapshot.resolve(key);
      const describe = def.describe as (v: unknown, c: RenderContext) => string;
      const text = describe(resolved.value, ctx);
      if (text === '') continue;
      rules.push({
        key,
        title: def.title,
        text,
        provenance: resolved.provenance,
        overrides: snapshot
          .records(key)
          .filter((r) => r.scope.type !== 'global')
          .map((r) => ({ scope: r.scope, text: describe(r.value, ctx) })),
      });
    }
    return { section, rules };
  }).filter((s) => s.rules.length > 0);

  return { versionLabel: snapshot.label, sections };
}
