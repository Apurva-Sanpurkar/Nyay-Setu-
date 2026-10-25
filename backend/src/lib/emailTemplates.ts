/**
 * Email templates.
 *
 * Email is not the web. Three constraints shape everything here:
 *
 *   1. **No <style> block.** Gmail's web client strips it, so every rule is an
 *      inline attribute. That is why this file looks like 2004.
 *   2. **No flexbox, no grid.** Outlook renders with Word's engine. Layout is
 *      tables, and anything that must be a shape is a baked image.
 *   3. **The logo is an attachment, not a URL.** A hotlinked image is blocked by
 *      default in most clients and would need a public host the project does not
 *      have. Sending it as an inline attachment referenced by Content-ID means it
 *      renders offline, on first open, with no image-loading prompt.
 *
 * The logo's white strokes are negative space, so the attached asset is
 * pre-composited onto a white plate. See scripts that generate email-logo.png.
 */

export const BRAND = {
  green: "#009245",
  greenLift: "#10b45f",
  orange: "#ff751f",
  canvas: "#05120c",
  surface: "#0a1d13",
  surfaceRaised: "#0e2418",
  border: "rgba(255,255,255,0.10)",
  text: "#eef5f0",
  muted: "#93a69b",
  faint: "#647469",
} as const;

/** The Content-ID the logo attachment is referenced by. */
export const LOGO_CID = "nyaysetu-logo";

interface ShellOptions {
  title: string;
  /** Sits under the wordmark; names what this message is about. */
  kicker: string;
  body: string;
  footnote?: string;
  /** Tints the header rule and the kicker. Orange means "act on this". */
  tone?: "green" | "orange";
}

/**
 * The shell every message shares.
 *
 * The header is a two-cell table rather than a flex row, and the gradient rule
 * beneath it is a 3px-tall table cell with a background colour, because a CSS
 * gradient is unreliable in Outlook and a solid bar always renders.
 */
export function shell({ title, kicker, body, footnote, tone = "green" }: ShellOptions): string {
  const accent = tone === "orange" ? BRAND.orange : BRAND.greenLift;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:${BRAND.canvas};">
  <!-- Preheader: the grey line a client shows beside the subject. Hidden in the
       body itself, which is why it is zero-height and transparent. -->
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
    ${escapeHtml(kicker)}
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
         style="background:${BRAND.canvas};padding:28px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
               style="max-width:540px;background:${BRAND.surface};border-radius:18px;overflow:hidden;
                      border:1px solid ${BRAND.border};">

          <!-- brand bar -->
          <tr>
            <td style="padding:22px 26px 18px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="padding-right:12px;vertical-align:middle;">
                    <img src="cid:${LOGO_CID}" width="44" height="44" alt=""
                         style="display:block;width:44px;height:44px;border-radius:12px;border:0;">
                  </td>
                  <td style="vertical-align:middle;">
                    <div style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
                                font-size:19px;font-weight:700;color:${BRAND.text};letter-spacing:-0.3px;line-height:1.1;">
                      NyaySetu
                    </div>
                    <div style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
                                font-size:11px;color:${accent};letter-spacing:1.3px;text-transform:uppercase;
                                font-weight:700;padding-top:4px;">
                      ${escapeHtml(kicker)}
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- The brand rule: green into orange, as three solid cells. A real
               gradient would not render in Outlook; three cells always will. -->
          <tr>
            <td style="padding:0;font-size:0;line-height:0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td height="3" width="55%" style="background:${BRAND.green};font-size:0;line-height:0;">&nbsp;</td>
                  <td height="3" width="20%" style="background:#7a8a2a;font-size:0;line-height:0;">&nbsp;</td>
                  <td height="3" width="25%" style="background:${BRAND.orange};font-size:0;line-height:0;">&nbsp;</td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- body -->
          <tr>
            <td style="padding:26px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
              <h1 style="margin:0 0 14px;font-size:21px;line-height:1.3;font-weight:600;color:${BRAND.text};">
                ${escapeHtml(title)}
              </h1>
              ${body}
            </td>
          </tr>

          <!-- footer -->
          <tr>
            <td style="padding:18px 26px 24px;border-top:1px solid ${BRAND.border};
                       font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
              ${
                footnote
                  ? `<p style="margin:0 0 10px;font-size:12px;line-height:1.6;color:${BRAND.muted};">${footnote}</p>`
                  : ""
              }
              <p style="margin:0;font-size:11px;line-height:1.6;color:${BRAND.faint};">
                Sent automatically by NyaySetu · न्यायसेतु. Do not reply to this address.
              </p>
            </td>
          </tr>
        </table>

        <p style="margin:16px 0 0;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
                  font-size:11px;color:${BRAND.faint};">
          Evidence, summons and bail, anchored to a public blockchain.
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * The code itself.
 *
 * Letter-spaced monospace in a bordered panel, large enough to read at arm's
 * length on a phone, and selectable as text so it can be copied rather than
 * retyped. An image of the code would defeat both.
 */
export function codePanel(code: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
         style="margin:0 0 20px;">
    <tr>
      <td align="center"
          style="background:${BRAND.surfaceRaised};border:1px solid ${BRAND.greenLift};
                 border-radius:14px;padding:20px 12px;">
        <div style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
                    font-size:32px;font-weight:700;letter-spacing:11px;color:${BRAND.greenLift};
                    line-height:1.1;padding-left:11px;">${escapeHtml(code)}</div>
        <div style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
                    font-size:11px;color:${BRAND.faint};letter-spacing:1.2px;text-transform:uppercase;
                    padding-top:10px;">Sign-in code</div>
      </td>
    </tr>
  </table>`;
}

/** A call to action. Padded table cell, not a styled anchor: Outlook again. */
export function button(href: string, label: string, tone: "green" | "orange" = "green"): string {
  const background = tone === "orange" ? BRAND.orange : BRAND.green;
  const colour = tone === "orange" ? "#0a1d13" : "#ffffff";

  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 0;">
    <tr>
      <td align="center" style="background:${background};border-radius:999px;">
        <a href="${escapeAttr(href)}"
           style="display:inline-block;padding:13px 28px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
                  font-size:13px;font-weight:700;letter-spacing:0.7px;text-transform:uppercase;
                  color:${colour};text-decoration:none;">${escapeHtml(label)}</a>
      </td>
    </tr>
  </table>`;
}

/**
 * A credential shown in an email.
 *
 * Monospace and letter-spaced so a temporary password can be read off a screen
 * and typed correctly. Selectable text, never an image: somebody will copy it.
 */
export function credentialRow(label: string, value: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 10px;">
    <tr>
      <td style="background:${BRAND.surfaceRaised};border:1px solid ${BRAND.border};border-radius:12px;padding:14px 16px;">
        <div style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
                    font-size:11px;color:${BRAND.faint};letter-spacing:1.2px;text-transform:uppercase;
                    padding-bottom:6px;">${escapeHtml(label)}</div>
        <div style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
                    font-size:17px;font-weight:700;letter-spacing:1.5px;color:${BRAND.text};
                    word-break:break-all;">${escapeHtml(value)}</div>
      </td>
    </tr>
  </table>`;
}

/** A numbered list of what to do next. */
export function steps(items: string[]): string {
  const rows = items
    .map(
      (item, index) => `<tr>
        <td width="26" valign="top" style="padding:0 0 12px;">
          <div style="width:20px;height:20px;border-radius:999px;background:${BRAND.green};
                      color:#ffffff;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
                      font-size:11px;font-weight:700;text-align:center;line-height:20px;">${index + 1}</div>
        </td>
        <td valign="top" style="padding:0 0 12px 10px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
                   font-size:13px;line-height:1.55;color:${BRAND.muted};">${item}</td>
      </tr>`
    )
    .join("");

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
           style="margin:0 0 18px;">${rows}</table>`;
}

/** A tinted callout for a deadline or a warning. */
export function callout(text: string, tone: "green" | "orange" | "red" = "orange"): string {
  const map = {
    green: { bg: "rgba(16,180,95,0.13)", border: "rgba(16,180,95,0.34)" },
    orange: { bg: "rgba(255,117,31,0.13)", border: "rgba(255,117,31,0.36)" },
    red: { bg: "rgba(244,84,95,0.13)", border: "rgba(244,84,95,0.36)" },
  }[tone];

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;">
    <tr>
      <td style="background:${map.bg};border:1px solid ${map.border};border-radius:12px;padding:14px 16px;
                 font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
                 font-size:13px;line-height:1.6;color:${BRAND.text};">${text}</td>
    </tr>
  </table>`;
}

export function paragraph(text: string): string {
  return `<p style="margin:0 0 16px;font-size:14px;line-height:1.65;color:${BRAND.muted};">${text}</p>`;
}

export function strong(text: string): string {
  return `<strong style="color:${BRAND.text};">${escapeHtml(text)}</strong>`;
}

/**
 * Escapes text destined for an HTML body.
 *
 * Not optional. A recipient name, an FIR number and a court name all reach these
 * templates from the database, and a name containing a bracket would otherwise
 * break the markup or inject into it.
 */
export function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/`/g, "&#96;");
}
