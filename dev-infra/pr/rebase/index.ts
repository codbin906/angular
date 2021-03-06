/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {types as graphQLTypes} from 'typed-graphqlify';
import {URL} from 'url';

import {getConfig, NgDevConfig} from '../../utils/config';
import {error, info, promptConfirm} from '../../utils/console';
import {GitClient} from '../../utils/git';
import {getPr} from '../../utils/github';

/* GraphQL schema for the response body for each pending PR. */
const PR_SCHEMA = {
  state: graphQLTypes.string,
  maintainerCanModify: graphQLTypes.boolean,
  viewerDidAuthor: graphQLTypes.boolean,
  headRefOid: graphQLTypes.string,
  headRef: {
    name: graphQLTypes.string,
    repository: {
      url: graphQLTypes.string,
      nameWithOwner: graphQLTypes.string,
    },
  },
  baseRef: {
    name: graphQLTypes.string,
    repository: {
      url: graphQLTypes.string,
      nameWithOwner: graphQLTypes.string,
    },
  },
};

/**
 * Rebase the provided PR onto its merge target branch, and push up the resulting
 * commit to the PRs repository.
 */
export async function rebasePr(
    prNumber: number, githubToken: string, config: Pick<NgDevConfig, 'github'> = getConfig()) {
  const git = new GitClient(githubToken);
  // TODO: Rely on a common assertNoLocalChanges function.
  if (git.hasLocalChanges()) {
    error('Cannot perform rebase of PR with local changes.');
    process.exit(1);
  }

  /**
   * The branch or revision originally checked out before this method performed
   * any Git operations that may change the working branch.
   */
  const previousBranchOrRevision = git.getCurrentBranchOrRevision();
  /* Get the PR information from Github. */
  const pr = await getPr(PR_SCHEMA, prNumber, config.github);

  const headRefName = pr.headRef.name;
  const baseRefName = pr.baseRef.name;
  const fullHeadRef = `${pr.headRef.repository.nameWithOwner}:${headRefName}`;
  const fullBaseRef = `${pr.baseRef.repository.nameWithOwner}:${baseRefName}`;
  const headRefUrl = addAuthenticationToUrl(pr.headRef.repository.url, githubToken);
  const baseRefUrl = addAuthenticationToUrl(pr.baseRef.repository.url, githubToken);

  // Note: Since we use a detached head for rebasing the PR and therefore do not have
  // remote-tracking branches configured, we need to set our expected ref and SHA. This
  // allows us to use `--force-with-lease` for the detached head while ensuring that we
  // never accidentally override upstream changes that have been pushed in the meanwhile.
  // See:
  // https://git-scm.com/docs/git-push#Documentation/git-push.txt---force-with-leaseltrefnamegtltexpectgt
  const forceWithLeaseFlag = `--force-with-lease=${headRefName}:${pr.headRefOid}`;

  // If the PR does not allow maintainers to modify it, exit as the rebased PR cannot
  // be pushed up.
  if (!pr.maintainerCanModify && !pr.viewerDidAuthor) {
    error(
        `Cannot rebase as you did not author the PR and the PR does not allow maintainers` +
        `to modify the PR`);
    process.exit(1);
  }

  try {
    // Fetch the branch at the commit of the PR, and check it out in a detached state.
    info(`Checking out PR #${prNumber} from ${fullHeadRef}`);
    git.run(['fetch', headRefUrl, headRefName]);
    git.run(['checkout', '--detach', 'FETCH_HEAD']);

    // Fetch the PRs target branch and rebase onto it.
    info(`Fetching ${fullBaseRef} to rebase #${prNumber} on`);
    git.run(['fetch', baseRefUrl, baseRefName]);
    info(`Attempting to rebase PR #${prNumber} on ${fullBaseRef}`);
    const rebaseResult = git.runGraceful(['rebase', 'FETCH_HEAD']);

    // If the rebase was clean, push the rebased PR up to the authors fork.
    if (rebaseResult.status === 0) {
      info(`Rebase was able to complete automatically without conflicts`);
      info(`Pushing rebased PR #${prNumber} to ${fullHeadRef}`);
      git.run(['push', headRefUrl, `HEAD:${headRefName}`, forceWithLeaseFlag]);
      info(`Rebased and updated PR #${prNumber}`);
      cleanUpGitState();
      process.exit(0);
    }
  } catch (err) {
    error(err.message);
    cleanUpGitState();
    process.exit(1);
  }

  // On automatic rebase failures, prompt to choose if the rebase should be continued
  // manually or aborted now.
  info(`Rebase was unable to complete automatically without conflicts.`);
  // If the command is run in a non-CI environment, prompt to format the files immediately.
  const continueRebase =
      process.env['CI'] === undefined && await promptConfirm('Manually complete rebase?');

  if (continueRebase) {
    info(`After manually completing rebase, run the following command to update PR #${prNumber}:`);
    info(` $ git push ${pr.headRef.repository.url} HEAD:${headRefName} ${forceWithLeaseFlag}`);
    info();
    info(`To abort the rebase and return to the state of the repository before this command`);
    info(`run the following command:`);
    info(` $ git rebase --abort && git reset --hard && git checkout ${previousBranchOrRevision}`);
    process.exit(1);
  } else {
    info(`Cleaning up git state, and restoring previous state.`);
  }

  cleanUpGitState();
  process.exit(1);

  /** Reset git back to the original branch. */
  function cleanUpGitState() {
    // Ensure that any outstanding rebases are aborted.
    git.runGraceful(['rebase', '--abort'], {stdio: 'ignore'});
    // Ensure that any changes in the current repo state are cleared.
    git.runGraceful(['reset', '--hard'], {stdio: 'ignore'});
    // Checkout the original branch from before the run began.
    git.runGraceful(['checkout', previousBranchOrRevision], {stdio: 'ignore'});
  }
}

/** Adds the provided token as username to the provided url. */
function addAuthenticationToUrl(urlString: string, token: string) {
  const url = new URL(urlString);
  url.username = token;
  return url.toString();
}
