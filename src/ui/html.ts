/** Minimal HTML templating with escaping on by default. */

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Marks a string as already-safe HTML so `html` does not re-escape it. */
export class Raw {
  constructor(readonly value: string) {}
}

export function raw(value: string): Raw {
  return new Raw(value);
}

/** Embeds a value as a JSON literal inside a <script> block. */
export function jsonScript(value: unknown): Raw {
  return raw(JSON.stringify(value).replace(/</g, "\\u003c"));
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): Raw {
  let out = "";
  strings.forEach((chunk, index) => {
    out += chunk;
    if (index >= values.length) return;
    out += renderValue(values[index]);
  });
  return raw(out);
}

function renderValue(value: unknown): string {
  if (value instanceof Raw) return value.value;
  if (Array.isArray(value)) return value.map(renderValue).join("");
  if (value === null || value === undefined || value === false) return "";
  return escapeHtml(value);
}

export function htmlResponse(body: Raw, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body.value, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", ...headers },
  });
}
