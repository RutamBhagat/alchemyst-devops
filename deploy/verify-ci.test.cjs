const assert = require('node:assert/strict');
const test = require('node:test');
const verifyCI = require('./verify-ci.cjs');

const sha = 'a'.repeat(40);
const passed = { id: 1, head_sha: sha, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success' };

function fixture(runs) {
  const context = { repo: { owner: 'owner', repo: 'repo' } };
  const listWorkflowRuns = () => {};
  const github = {
    rest: {
      repos: { getCommit: async args => {
        assert.deepEqual(args, { ...context.repo, ref: 'release-tag' });
        return { data: { sha } };
      } },
      actions: { listWorkflowRuns },
    },
    paginate: async (method, args) => {
      assert.equal(method, listWorkflowRuns);
      assert.deepEqual(args, { ...context.repo, workflow_id: 'ci.yml', head_sha: sha, branch: 'main', event: 'push', per_page: 100 });
      return runs;
    },
  };
  return { github, context, ref: 'release-tag' };
}

test('returns the resolved SHA for deployment and rollback of a CI-passed ref', async () => {
  assert.equal(await verifyCI(fixture([passed])), sha);
});

test('rejects missing CI and failed, skipped, or unfinished runs', async () => {
  for (const runs of [[], [{ ...passed, conclusion: 'failure' }], [{ ...passed, conclusion: 'skipped' }], [{ ...passed, status: 'in_progress', conclusion: null }]]) {
    await assert.rejects(verifyCI(fixture(runs)), /successful latest CI push run/);
  }
});

test('a previous success cannot override a newer failed or pending run', async () => {
  for (const run of [{ ...passed, id: 2, conclusion: 'failure' }, { ...passed, id: 2, status: 'queued', conclusion: null }]) {
    await assert.rejects(verifyCI(fixture([passed, run])), /successful latest CI push run/);
  }
});

test('rejects CI for another SHA, branch, or a PR event', async () => {
  for (const run of [{ ...passed, head_sha: 'b'.repeat(40) }, { ...passed, head_branch: 'feature' }, { ...passed, event: 'pull_request' }]) {
    await assert.rejects(verifyCI(fixture([run])), /successful latest CI push run/);
  }
});
