/** Markup that is already escaped. Only `html` and `raw` create it. */
export class Html {
  constructor(readonly value: string) {}
  toString() { return this.value; }
}

type Part = Html | string | number | null | undefined | false | readonly Part[];

const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escape = (value: string) => value.replace(/[&<>"']/g, character => entities[character]);

function render(part: Part): string {
  if (part instanceof Html) return part.value;
  if (Array.isArray(part)) return part.map(render).join("");
  if (part === null || part === undefined || part === false) return "";
  return escape(String(part));
}

/** Escapes every interpolated value unless it is already `Html`. */
export function html(strings: TemplateStringsArray, ...values: Part[]): Html {
  let out = strings[0];
  for (let index = 0; index < values.length; index++) out += render(values[index]) + strings[index + 1];
  return new Html(out);
}

/** Trusted, first-party markup such as translated copy containing links. */
export const raw = (value: string) => new Html(value);

/** JSON for <script type="application/ld+json">; `<` is escaped so content cannot close the element. */
export const jsonScript = (value: unknown) =>
  raw(`<script type="application/ld+json">${JSON.stringify(value).replace(/</g, "\\u003c")}</script>`);
