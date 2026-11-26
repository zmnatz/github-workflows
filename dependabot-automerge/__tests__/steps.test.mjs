// Runs the workflow's own shell scripts, as read from its YAML, the way a runner would.
// What this does not cover: how the jobs are wired together (if, needs, env, permissions).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workflow = new URL('../../.github/workflows/dependabot-automerge.yml', import.meta.url);

/** The `run: |` block of the step with this id. */
function script(id) {
  const lines = readFileSync(workflow, 'utf8').split('\n');
  const step = lines.findIndex((line) => line.trim().replace(/^- /, '') === `id: ${id}`);
  assert.notEqual(step, -1, `no step with id ${id}`);
  const run = lines.findIndex((line, i) => i > step && line.trim().replace(/^- /, '') === 'run: |');
  assert.notEqual(run, -1, `step ${id} has no run block`);
  const indent = lines[run].search(/\S/);
  const body = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() && line.search(/\S/) <= indent) break;
    body.push(line);
  }
  const margin = body[0].search(/\S/);
  return body.map((line) => line.slice(margin)).join('\n');
}

/** A step's script, run with only these variables (and a PATH). */
function run(id, env) {
  return spawnSync('bash', ['-eo', 'pipefail', '-c', script(id)], {
    env: { PATH: process.env.PATH, ...env },
    encoding: 'utf8',
  });
}

/** Whether a Dependabot update qualifies, and how the step ended. */
function eligibility(env) {
  const output = join(mkdtempSync(join(tmpdir(), 'eligible-')), 'output');
  writeFileSync(output, '');
  const result = run('eligible', {
    GITHUB_OUTPUT: output,
    UPDATE_TYPES: '',
    GROUP_SUFFIXES: '',
    METHOD: 'squash',
    UPDATE_TYPE: '',
    GROUP: '',
    ...env,
  });
  return { ...result, eligible: readFileSync(output, 'utf8').includes('eligible=true') };
}

/** The arguments the merge step calls gh with, gh itself being a stand-in that records them. */
function merge(env) {
  const dir = mkdtempSync(join(tmpdir(), 'merge-'));
  const calls = join(dir, 'calls');
  writeFileSync(join(dir, 'gh'), '#!/bin/sh\nprintf \'%s\\n\' "$@" >> "$CALLS"\n', { mode: 0o755 });
  const result = run('merge', { PATH: `${dir}:${process.env.PATH}`, CALLS: calls, ...env });
  assert.equal(result.status, 0, result.stderr);
  return readFileSync(calls, 'utf8').trimEnd().split('\n');
}

describe('which updates are merged', () => {
  it('an allowed update type qualifies', () => {
    const result = eligibility({ UPDATE_TYPES: 'patch', UPDATE_TYPE: 'version-update:semver-patch' });
    assert.equal(result.status, 0);
    assert.equal(result.eligible, true);
  });

  it('any of several allowed update types qualifies, and no other', () => {
    for (const list of ['patch minor', 'patch, minor', 'patch\nminor\n']) {
      assert.equal(eligibility({ UPDATE_TYPES: list, UPDATE_TYPE: 'version-update:semver-minor' }).eligible, true, list);
      const major = eligibility({ UPDATE_TYPES: list, UPDATE_TYPE: 'version-update:semver-major' });
      assert.equal(major.eligible, false, list);
      assert.equal(major.status, 0, 'an update left for review is not a failure');
    }
  });

  it('a group with an allowed suffix qualifies, whatever its update type', () => {
    for (const GROUP of ['media-patch', 'openwebui-auto']) {
      const result = eligibility({ GROUP_SUFFIXES: '-patch, -auto', GROUP, UPDATE_TYPE: 'version-update:semver-major' });
      assert.equal(result.eligible, true, GROUP);
    }
  });

  it('a group without an allowed suffix, or no group, does not qualify', () => {
    for (const GROUP of ['', 'media-minor', 'patch-media', 'media-patched']) {
      const result = eligibility({ GROUP_SUFFIXES: '-patch -auto', GROUP });
      assert.equal(result.status, 0, GROUP);
      assert.equal(result.eligible, false, GROUP);
    }
  });

  it('a suffix is literal text, not a pattern', () => {
    assert.equal(eligibility({ GROUP_SUFFIXES: '*', GROUP: 'media-minor' }).eligible, false);
  });

  it('with nothing allowed, the step fails rather than silently never merging', () => {
    const result = eligibility({ UPDATE_TYPE: 'version-update:semver-patch', GROUP: 'media-patch' });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /::error::.*update-types.*group-suffixes/);
    assert.equal(result.eligible, false);
  });

  it('an update type other than patch, minor or major fails', () => {
    for (const UPDATE_TYPES of ['pacth', 'version-update:semver-patch']) {
      const result = eligibility({ UPDATE_TYPES, GROUP_SUFFIXES: '-patch', GROUP: 'media-patch' });
      assert.notEqual(result.status, 0, UPDATE_TYPES);
      assert.match(result.stdout, /::error::.*patch, minor or major/);
      assert.equal(result.eligible, false);
    }
  });

  it('an unknown merge method fails before anything is checked or merged', () => {
    const result = eligibility({ UPDATE_TYPES: 'patch', UPDATE_TYPE: 'version-update:semver-patch', METHOD: 'fast-forward' });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /::error::.*squash, merge or rebase/);
    assert.equal(result.eligible, false);
  });
});

describe('the merge', () => {
  it('merges the pull request by the chosen method, only at the commit that was checked', () => {
    for (const METHOD of ['squash', 'merge', 'rebase']) {
      const args = merge({
        METHOD,
        PR_URL: 'https://github.com/octo/site/pull/7',
        SHA: '0123abc',
        GITHUB_REPOSITORY: 'octo/site',
      });
      assert.deepEqual(args, [
        'pr', 'merge', 'https://github.com/octo/site/pull/7',
        `--${METHOD}`,
        '--match-head-commit', '0123abc',
        '--delete-branch',
        '--repo', 'octo/site',
      ]);
    }
  });
});
