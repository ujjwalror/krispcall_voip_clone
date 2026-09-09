import { NextResponse } from 'next/server';

export async function POST() {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say>Twilio voice connection is configured successfully for Legendary Careers.</Say>
</Response>`;

  return new NextResponse(twiml, {
    status: 200,
    headers: {
      'Content-Type': 'text/xml',
    },
  });
}

export async function GET() {
  return POST();
}
