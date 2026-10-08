// Resolve once so a moving branch/tag cannot change the revision after validation.
module.exports = async function verifyCI({ github, context, ref }) {
  const { data: commit } = await github.rest.repos.getCommit({ ...context.repo, ref });
  const runs = await github.paginate(github.rest.actions.listWorkflowRuns, {
    ...context.repo,
    workflow_id: 'ci.yml',
    head_sha: commit.sha,
    branch: 'main',
    event: 'push',
    per_page: 100,
  });
  const latest = runs
    .filter(run => run.head_sha === commit.sha && run.head_branch === 'main' && run.event === 'push')
    .sort((a, b) => b.id - a.id)[0];
  if (!latest || latest.status !== 'completed' || latest.conclusion !== 'success') {
    throw new Error(`Commit ${commit.sha} must have a successful latest CI push run on main before deployment.`);
  }
  return commit.sha;
};
