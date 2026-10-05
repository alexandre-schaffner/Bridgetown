// `bun run deploy` is for .github/workflows/deploy-site.yml only. A deploy from a laptop ships
// whatever is in its working tree, and the next CI deploy from main quietly replaces it: the
// board hero was lost that way. Merge to main instead, or run the workflow by hand.
if (process.env.GITHUB_ACTIONS !== "true") {
  console.error("The site deploys from CI: merge to main, or run `gh workflow run deploy-site.yml`.");
  process.exit(1);
}
