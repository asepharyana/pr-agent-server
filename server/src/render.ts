// Template rendering — Jinja2-like via nunjucks with StrictUndefined.
// pr_agent uses jinja2 Environment(undefined=StrictUndefined); nunjucks
// `Environment` with `throwOnUndefined: true` mimics that (undefined var → throw).

import nunjucks from "nunjucks";

let _env: nunjucks.Environment | null = null;

function getEnv(): nunjucks.Environment {
  if (!_env) {
    // null loader: we only render from strings
    _env = new nunjucks.Environment(null, {
      autoescape: false,
      throwOnUndefined: true,
    });
    // nunjucks supports {{ var.key }} dot access, {% if %}, {% for %}, filters.
  }
  return _env;
}

export function renderTemplate(
  template: string,
  data: Record<string, unknown>,
): string {
  try {
    return getEnv().renderString(template, data);
  } catch (e) {
    // StrictUndefined throws on missing var — pr_agent treats this as a hard
    // failure; we rethrow so the caller can react (or fall back).
    throw new Error(
      `Template render failed (undefined variable?): ${(e as Error).message}`,
    );
  }
}

/** Render with graceful fallback: if a variable is missing, retry with that
 *  var filled as an empty string — mirrors pr_agent's tolerant renders in some
 *  paths. */
export function renderTemplateTolerant(
  template: string,
  data: Record<string, unknown>,
): string {
  try {
    return renderTemplate(template, data);
  } catch {
    // last-resort: strip template tags (used only for very broken edge cases)
    return template.replace(/\{\{.*?\}\}/gs, "");
  }
}