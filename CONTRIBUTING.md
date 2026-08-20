# Contributing to PR-Agent Server

## Development Workflow

1. Fork the repo
2. Create a feature branch: `git checkout -b feat/your-feature`
3. Make changes — keep files organized in the project layout:
   - `src/` for application modules
   - `scripts/` for setup/deployment helpers
   - `templates/` for config templates
4. Syntax check: `python3 -m py_compile src/*.py scripts/*.py`
5. Nix build: `nix build .#default` (verify the flake still builds)
6. Commit with descriptive message + push
7. Open PR — the server's auto-merge bot will review it

## Standards

- **Python**: 4-space indent, type hints where practical, no hardcode secrets
- **Secrets**: Always via environment variables or BWS at runtime — never in source
- **Model names**: Must be tested live against 9router before committing (strip `openai/` prefix issue)
- **Nix**: Update `flake.nix` `installPhase` if you move files between directories

## Testing Checklist

- [ ] `python3 -m py_compile` passes on all modified files
- [ ] `nix build .#default` succeeds
- [ ] CI syntax-check job passes
- [ ] New models tested via curl to 9router (not assumed)
- [ ] No secret values in git history (`sk-[a-z0-9]+` patterns)
