/**
 * Cloudflare Pages Function — enquiry form endpoint.
 *
 * Runs server-side, so there are no CORS issues and the CRM webhook URL never
 * needs to be trusted to the browser. Forwards the enquiry into GoHighLevel so
 * it lands in the same pipeline as the lead-magnet downloads and triggers the
 * existing instant-reply / nurture automation.
 *
 * The email copy to Alex is sent from the browser (assets/notify-*.js), because
 * FormSubmit blocks requests from Cloudflare's servers.
 *
 * Set GHL_WEBHOOK_URL (comma separated for several) as an environment variable
 * in the Cloudflare Pages project to override the webhooks below.
 */

// The older GHL account that has always received website leads, plus the new
// workflow in the ElevateX sub-account (starts running once it is published).
const GHL_FALLBACK = [
  'https://services.leadconnectorhq.com/hooks/IyTdSIf5Wpb5miDIfc9E/webhook-trigger/f001a49a-14b3-43a8-b888-9efd1ad65df1',
  'https://services.leadconnectorhq.com/hooks/qVufP0lhSYGIZE0j9nRm/webhook-trigger/5564b2a5-0839-44ec-b96d-5d8105eff695',
]

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

  // Lead magnet downloads (industry pages) only ask for an email; name is optional.
  const isMagnet = data['form-name'] === 'lead-magnet'
  const industry = /^[a-z0-9-]{1,80}$/.test((data.industry || '').trim()) ? data.industry.trim() : ''
  const magnet = /^[a-z0-9-]{1,80}\.pdf$/.test((data.magnet || '').trim()) ? data.magnet.trim() : ''

  if (!email.includes('@') || (!name && !isMagnet)) {
    return json({ ok: false, error: 'Name and a valid email are required' }, 400)
  }

  if (isMagnet) {
    // Same payload shape the industry pages used to post to GHL directly,
    // so existing GHL workflows keep working.
    return forward(env, json, {
      email,
      firstName: name || undefined,
      source: 'Website PDF download',
      industry,
      magnet,
      tags: ['lead-magnet', 'website-lead', ...(industry ? [`industry-${industry}`] : [])],
      customField: {
        lead_source_detail: `Industry money page: ${industry || page}`,
        magnet_downloaded: magnet,
      },
    })
  }

  const payload = {
    email,
    firstName: name,
    companyName: company || undefined,
    source: campaign === 'ads-relaunch' ? 'Ads relaunch application' : 'Website enquiry form',
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

  return forward(env, json, payload)
}

// Every form ends here. Set GHL_WEBHOOK_URL in the Cloudflare Pages project to
// change which GHL location receives leads without touching code.
async function forward(
  env: Env,
  json: (body: unknown, status?: number) => Response,
  payload: Record<string, unknown>,
) {
  // GHL webhook workflows map fields by whatever key the builder picked, so send
  // the common spellings too. Contacts were arriving with no name or company.
  const first = payload.firstName as string | undefined
  const company = payload.companyName as string | undefined
  const body = {
    ...payload,
    first_name: first,
    name: first,
    full_name: first,
    company_name: company,
    company,
  }
  const targets = env.GHL_WEBHOOK_URL
    ? env.GHL_WEBHOOK_URL.split(',').map((u) => u.trim()).filter(Boolean)
    : GHL_FALLBACK
  const sends = [
    ...targets.map((url) =>
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then((r) => r.ok),
    ),
  ]
  const results = await Promise.allSettled(sends)
  const okAt = results.map((r) => r.status === 'fulfilled' && r.value === true)
  // How many GHL webhooks took it, for debugging.
  const delivered = { crm: okAt.filter(Boolean).length }
  // The lead is safe as long as one destination took it.
  if (okAt.some(Boolean)) return json({ ok: true, delivered })
  return json({ ok: false, error: 'Could not deliver the submission', delivered }, 502)
}

