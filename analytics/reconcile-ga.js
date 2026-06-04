#!/usr/bin/env node
'use strict';

/*
 * Reconcile GA4 config-as-code (analytics/ga-config.json) against a GA4 property
 * using the GA4 Admin API. Idempotent: lists what exists, CREATEs what's missing,
 * PATCHes what drifted, and (only with --prune) archives/deletes what was removed
 * from the config file.
 *
 * This is the GA analogue of `supabase db push` in .github/workflows/db-migrate.yml.
 * Prod is read-only from every interactive surface; the only thing that writes GA
 * config is this script, running in CI on a commit that landed on main.
 *
 * Usage:
 *   node analytics/reconcile-ga.js [--dry-run] [--prune] [--config <path>]
 *
 *   --dry-run   Print the plan (create / patch / archive / delete) and exit without
 *               touching GA. Used for the PR safety-net preview.
 *   --prune     Allow destructive ops (archive dimensions/metrics, delete key events)
 *               for definitions present in GA but absent from the config. Off by
 *               default so a normal apply can never silently drop a definition.
 *
 * Auth: standard Application Default Credentials. CI writes the service-account JSON
 * key to a file and points GOOGLE_APPLICATION_CREDENTIALS at it. The service account
 * needs the Editor role on the GA4 property (Admin -> Property Access Management).
 */

const fs = require('fs');
const path = require('path');
const { AnalyticsAdminServiceClient } = require('@google-analytics/admin');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const PRUNE = args.includes('--prune');
const configPath = (() => {
  const i = args.indexOf('--config');
  return i !== -1 && args[i + 1]
    ? path.resolve(args[i + 1])
    : path.join(__dirname, 'ga-config.json');
})();

// GitHub Actions log grouping (no-op locally — just prints the markers).
const group = async (title, fn) => {
  console.log(`::group::${title}`);
  try {
    return await fn();
  } finally {
    console.log('::endgroup::');
  }
};

// GA4 Admin API field limits for custom dimensions/metrics. Enforced at LOAD time so
// the PR dry-run fails on a violation — the API only rejects on the real apply, which
// is how an over-length description once slipped through review and broke the main
// apply (playlist, 170 > 150).
const GA_FIELD_LIMITS = { parameterName: 40, displayName: 82, description: 150 };
// Charset rules, same reasoning: the API rejects these only at apply time — which is
// how "Duration (s)" (parentheses in a displayName) slipped past the dry-run and broke
// the main apply mid-run (dimensions created, metrics/keyEvents not).
//   displayName:   letters, digits, underscores, spaces
//   parameterName: letters, digits, underscores; must start with a letter
//   keyEvent name: same rules as parameterName (GA event-name constraints)
const GA_DISPLAY_NAME_RE = /^[A-Za-z0-9_ ]+$/;
const GA_PARAMETER_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
function validateFieldLimits(kind, entries) {
  for (const e of entries || []) {
    for (const [field, max] of Object.entries(GA_FIELD_LIMITS)) {
      const v = e[field];
      if (typeof v === 'string' && v.length > max) {
        throw new Error(
          `${kind} "${e.parameterName}": ${field} is ${v.length} chars (GA4 max ${max}). Shorten it in ga-config.json.`
        );
      }
    }
    if (typeof e.displayName === 'string' && !GA_DISPLAY_NAME_RE.test(e.displayName)) {
      throw new Error(
        `${kind} "${e.parameterName}": displayName "${e.displayName}" has characters GA4 rejects ` +
        `(only letters, digits, underscores, and spaces are allowed). Fix it in ga-config.json.`
      );
    }
    if (typeof e.parameterName === 'string' && !GA_PARAMETER_NAME_RE.test(e.parameterName)) {
      throw new Error(
        `${kind} "${e.parameterName}": parameterName must start with a letter and contain only ` +
        `letters, digits, and underscores. Fix it in ga-config.json.`
      );
    }
  }
}
function validateKeyEvents(entries) {
  for (const e of entries || []) {
    const name = e.eventName;
    if (typeof name !== 'string' || name.length > 40 || !GA_PARAMETER_NAME_RE.test(name)) {
      throw new Error(
        `keyEvent "${name}": eventName must be 1-40 chars, start with a letter, and contain only ` +
        `letters, digits, and underscores. Fix it in ga-config.json.`
      );
    }
  }
}

function loadConfig() {
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const propertyId = String(raw.propertyId || '').replace(/^properties\//, '');
  if (!/^\d+$/.test(propertyId)) {
    throw new Error(`config.propertyId must be a numeric GA4 property id, got: ${raw.propertyId}`);
  }
  validateFieldLimits('customDimension', raw.customDimensions);
  validateFieldLimits('customMetric', raw.customMetrics);
  validateKeyEvents(raw.keyEvents);
  return {
    parent: `properties/${propertyId}`,
    propertyId,
    customDimensions: raw.customDimensions || [],
    customMetrics: raw.customMetrics || [],
    keyEvents: raw.keyEvents || [],
  };
}

// Accumulated plan, printed as a summary at the end (and the only output in dry-run).
const plan = { create: [], patch: [], archive: [], delete: [], noop: 0 };
const record = (bucket, line) => {
  if (bucket === 'noop') plan.noop += 1;
  else plan[bucket].push(line);
};

async function reconcileCustomDimensions(client, cfg) {
  const [existing] = await client.listCustomDimensions({ parent: cfg.parent });
  const byKey = new Map(existing.map((d) => [`${d.scope}:${d.parameterName}`, d]));

  for (const want of cfg.customDimensions) {
    const key = `${want.scope}:${want.parameterName}`;
    const have = byKey.get(key);
    if (!have) {
      record('create', `customDimension ${key} ("${want.displayName}")`);
      if (!DRY_RUN) {
        await client.createCustomDimension({
          parent: cfg.parent,
          customDimension: {
            parameterName: want.parameterName,
            displayName: want.displayName,
            scope: want.scope,
            description: want.description || '',
          },
        });
      }
      continue;
    }
    byKey.delete(key); // mark as seen
    const updateMask = [];
    if ((have.displayName || '') !== (want.displayName || '')) updateMask.push('display_name');
    if ((have.description || '') !== (want.description || '')) updateMask.push('description');
    // parameterName and scope are immutable in GA4 — never patched.
    if (updateMask.length === 0) {
      record('noop');
      continue;
    }
    record('patch', `customDimension ${key} [${updateMask.join(', ')}]`);
    if (!DRY_RUN) {
      await client.updateCustomDimension({
        customDimension: { name: have.name, displayName: want.displayName, description: want.description || '' },
        updateMask: { paths: updateMask },
      });
    }
  }

  // Anything left in byKey exists in GA but not in config.
  for (const [key, have] of byKey) {
    if (PRUNE) {
      record('archive', `customDimension ${key} ("${have.displayName}")`);
      if (!DRY_RUN) await client.archiveCustomDimension({ name: have.name });
    } else {
      record('noop');
      console.log(`  · keeping un-managed customDimension ${key} (use --prune to archive)`);
    }
  }
}

async function reconcileCustomMetrics(client, cfg) {
  const [existing] = await client.listCustomMetrics({ parent: cfg.parent });
  const byKey = new Map(existing.map((m) => [`${m.scope}:${m.parameterName}`, m]));

  for (const want of cfg.customMetrics) {
    const key = `${want.scope}:${want.parameterName}`;
    const have = byKey.get(key);
    if (!have) {
      record('create', `customMetric ${key} ("${want.displayName}")`);
      if (!DRY_RUN) {
        await client.createCustomMetric({
          parent: cfg.parent,
          customMetric: {
            parameterName: want.parameterName,
            displayName: want.displayName,
            scope: want.scope,
            measurementUnit: want.measurementUnit || 'STANDARD',
            description: want.description || '',
          },
        });
      }
      continue;
    }
    byKey.delete(key);
    const updateMask = [];
    if ((have.displayName || '') !== (want.displayName || '')) updateMask.push('display_name');
    if ((have.description || '') !== (want.description || '')) updateMask.push('description');
    // parameterName, scope, measurementUnit are immutable in GA4 — never patched.
    if (updateMask.length === 0) {
      record('noop');
      continue;
    }
    record('patch', `customMetric ${key} [${updateMask.join(', ')}]`);
    if (!DRY_RUN) {
      await client.updateCustomMetric({
        customMetric: { name: have.name, displayName: want.displayName, description: want.description || '' },
        updateMask: { paths: updateMask },
      });
    }
  }

  for (const [key, have] of byKey) {
    if (PRUNE) {
      record('archive', `customMetric ${key} ("${have.displayName}")`);
      if (!DRY_RUN) await client.archiveCustomMetric({ name: have.name });
    } else {
      record('noop');
      console.log(`  · keeping un-managed customMetric ${key} (use --prune to archive)`);
    }
  }
}

async function reconcileKeyEvents(client, cfg) {
  const [existing] = await client.listKeyEvents({ parent: cfg.parent });
  const byName = new Map(existing.map((e) => [e.eventName, e]));

  for (const want of cfg.keyEvents) {
    const have = byName.get(want.eventName);
    if (!have) {
      record('create', `keyEvent "${want.eventName}"`);
      if (!DRY_RUN) {
        await client.createKeyEvent({
          parent: cfg.parent,
          keyEvent: {
            eventName: want.eventName,
            countingMethod: want.countingMethod || 'ONCE_PER_EVENT',
          },
        });
      }
      continue;
    }
    byName.delete(want.eventName);
    record('noop'); // countingMethod patch is rarely needed; treat presence as satisfied.
  }

  for (const [name, have] of byName) {
    if (PRUNE) {
      record('delete', `keyEvent "${name}"`);
      if (!DRY_RUN) await client.deleteKeyEvent({ name: have.name });
    } else {
      record('noop');
      console.log(`  · keeping un-managed keyEvent "${name}" (use --prune to delete)`);
    }
  }
}

async function main() {
  const cfg = loadConfig();
  console.log(`GA config-as-code → property ${cfg.parent}`);
  console.log(`mode: ${DRY_RUN ? 'DRY RUN (no changes)' : 'APPLY'}${PRUNE ? ' +prune' : ''}`);
  console.log(`config: ${configPath}\n`);

  const client = new AnalyticsAdminServiceClient();

  await group('Custom dimensions', () => reconcileCustomDimensions(client, cfg));
  await group('Custom metrics', () => reconcileCustomMetrics(client, cfg));
  await group('Key events', () => reconcileKeyEvents(client, cfg));

  console.log('\n=== Plan ===');
  const show = (label, arr) => arr.forEach((l) => console.log(`  ${label}  ${l}`));
  show('CREATE ', plan.create);
  show('PATCH  ', plan.patch);
  show('ARCHIVE', plan.archive);
  show('DELETE ', plan.delete);
  const changes = plan.create.length + plan.patch.length + plan.archive.length + plan.delete.length;
  console.log(
    `\n${changes} change(s), ${plan.noop} already in sync.` +
      (DRY_RUN && changes ? ' (dry run — nothing applied)' : '')
  );
}

main().catch((err) => {
  console.error('\nGA reconcile failed:', err && err.message ? err.message : err);
  process.exit(1);
});
