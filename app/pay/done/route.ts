import { NextResponse } from "next/server";

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Thank you</title>
<style>body{font-family:system-ui,sans-serif;margin:0;display:grid;min-height:100vh;place-items:center;background:#f7f7f8;color:#1b1b1f}
main{max-width:28rem;padding:2rem;text-align:center}h1{font-size:1.4rem}p{line-height:1.5;color:#55555c}</style></head>
<body><main><h1>Thank you</h1><p>You can close this page. If you paid, the clinic will receive confirmation from the payment provider shortly.
If you have a question, please contact the clinic.</p></main></body></html>`;

const headers = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "public, max-age=3600",
  "X-Robots-Tag": "noindex",
  "Referrer-Policy": "no-referrer",
};

export async function GET() {
  return new NextResponse(PAGE, { status: 200, headers });
}

/** PayTabs sends the patient back with a POST; the body is ignored. */
export async function POST() {
  return new NextResponse(PAGE, { status: 200, headers });
}
