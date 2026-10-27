# Maintaining the Zaknin L2Solo fork

The fork starts from `pmbstyle/L2Solo` main at `95e0bf913231979b44bf86ebe251f9a2645f23ea`.

- `origin` is `https://github.com/Zaknin/L2Solo`.
- `upstream` is `https://github.com/pmbstyle/L2Solo`.
- `main` follows the upstream baseline. Local customizations belong on `production-customizations`.

## Bring in an upstream update

Fetch both remotes and fast-forward the local baseline only when it can move forward cleanly:

```powershell
git fetch origin
git fetch upstream
git switch main
git merge --ff-only upstream/main
git push origin main
```

Merge the updated baseline into the customization branch. This preserves the customization commits and avoids rewriting published history:

```powershell
git switch production-customizations
git merge --no-ff main
npm ci
npm run check
node --require tests/helpers/databaseIsolation.js tests/test_wolf_follow_experience.js
```

Resolve conflicts by reviewing both the upstream and local behavior. Re-run the syntax and relevant offline tests before publishing the branch:

```powershell
git status --short
git push origin production-customizations
```

Do not force-push or rebase the published customization branch. Keep production databases, private settings, logs, client `.dat` files, and third-party archives out of Git. Publish third-party changes only after their redistribution terms are confirmed. The production server remains a separate deployment target; validate changes in the fork before any owner-managed deployment.