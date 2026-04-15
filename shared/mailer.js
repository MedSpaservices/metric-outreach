import 'dotenv/config';

export async function sendEmail(to, subject, body) {
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': process.env.BREVO_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sender: { name: process.env.BREVO_FROM_NAME || 'Metric', email: process.env.BREVO_FROM_EMAIL },
      to: [{ email: to }],
      subject,
      textContent: body,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Brevo error: ${err}`);
  }
}
