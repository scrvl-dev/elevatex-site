/**
 * Cloudflare Pages Function — enquiry form endpoint.
 *
 * Runs server-side, so there are no CORS issues and the CRM webhook URL never
 * needs to be trusted to the browser. Forwards the enquiry into GoHighLevel so
 * it lands in the same pipeline as the lead-magnet downloads and triggers the
 * existing instant-reply / nurture automation.
 *
 * Set GHL_WEBHOOK_URL as an environment variable in the Cloudflare Pages
 * project; the literal below is the fallback so it works without config.
 */

const GHL_FALLBACK =
  'https://services.leadconnectorhq.com/hooks/IyTdSIf5Wpb5miDIfc9E/webhook-trigger/f001a49a-14b3-43a8-b888-9efd1ad65df1'

interface Env {
  GHL_WEBHOOK_URL?: string
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })

  let data: Record<string, string>
  try {
    const ct = request.headers.get('content-type') || ''
    if (ct.includes('application/json')) {
      data = (await request.json()) as Record<string, string>
    } else {
      const form = await request.formData()
      data = Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]))
    }
  } catch {
    return json({ ok: false, error: 'Could not read submission' }, 400)
  }

  // Honeypot — silently accept so bots don't learn they were caught.
  if (data['bot-field']) return json({ ok: true })

  const name = (data.name || '').trim()
  const email = (data.email || '').trim()
  const company = (data.company || '').trim()
  const message = (data.message || '').trim()
  const page = (data.page || '').trim().slice(0, 200)
  // The /ads application sends campaign and qualifying fields; fold them into
  // the CRM message and tag so they can be routed separately.
  const rawCampaign = (data.campaign || '').trim().slice(0, 60)
  const campaign = /^[a-z0-9-]+$/.test(rawCampaign) ? rawCampaign : ''
  const extras = [
    ['Website', data.website],
    ['Category', data.category],
    ['Monthly revenue', data.revenue],
    ['Ads status', data.ad_status],
  ]
    .filter(([, v]) => v && String(v).trim())
    .map(([k, v]) => `${k}: ${String(v).trim().slice(0, 200)}`)
  const fullMessage = [...extras, message].filter(Boolean).join('\n')

  if (!email.includes('@') || !name) {
    return json({ ok: false, error: 'Name and a valid email are required' }, 400)
  }

  const payload = {
    email,
    firstName: name,
    companyName: company || undefined,
    source: 'ElevateX Website — Enquiry Form',
    tags: ['website-enquiry', 'website-lead', ...(campaign ? [campaign] : [])],
    customField: {
      lead_source_detail: page
        ? `Enquiry form on ${page}`
        : 'Landing page enquiry form (not ready to book)',
      enquiry_message: fullMessage,
      company: company,
    },
    message: fullMessage,
  }

  try {
    const res = await fetch(env.GHL_WEBHOOK_URL || GHL_FALLBACK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) return json({ ok: false, error: 'CRM rejected the submission' }, 502)
    return json({ ok: true })
  } catch {
    return json({ ok: false, error: 'Could not reach the CRM' }, 502)
  }
}
