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
 *
 * The pre-call growth audit (/growth-audit) uses this same endpoint. Audit
 * submissions are tagged growth-audit and also go to their own GoHighLevel
 * inbound webhook in the ElevateX location (GROWTH_AUDIT_WEBHOOK below, or the
 * GHL_GROWTH_AUDIT_WEBHOOK_URL environment variable to override it). They are
 * also forwarded to the EX 16 n8n workflow (N8N_GROWTH_AUDIT_FALLBACK below, or
 * the N8N_GROWTH_AUDIT_WEBHOOK environment variable). That workflow is inactive
 * until it is published, so a failed n8n post must not fail the submission.
 */

// The older GHL account that has always received website leads, plus the new
// workflow in the ElevateX sub-account (starts running once it is published).
const GHL_FALLBACK = [
  'https://services.leadconnectorhq.com/hooks/IyTdSIf5Wpb5miDIfc9E/webhook-trigger/f001a49a-14b3-43a8-b888-9efd1ad65df1',
  'https://services.leadconnectorhq.com/hooks/qVufP0lhSYGIZE0j9nRm/webhook-trigger/5564b2a5-0839-44ec-b96d-5d8105eff695',
]

// Growth audit workflow in the ElevateX GHL location (d3fMlmjwHd9WhsME417w), added 12 Nov 2026.
const GROWTH_AUDIT_WEBHOOK =
  'https://services.leadconnectorhq.com/hooks/d3fMlmjwHd9WhsME417w/webhook-trigger/ab465ddf-6366-4b72-a9ee-a739e6185cb1'

// EX 16 Growth audit on n8n. The webhook does not accept traffic until the
// workflow is published. The site still succeeds when only GoHighLevel answers.
const N8N_GROWTH_AUDIT_FALLBACK =
  'https://elevatex-solutions.app.n8n.cloud/webhook/ex/inbound/growth-audit/Acg5jbkaFXE813CtYvcqcZ79'

interface Env {
  GHL_WEBHOOK_URL?: string
  GHL_GROWTH_AUDIT_WEBHOOK_URL?: string
  N8N_GROWTH_AUDIT_WEBHOOK?: string
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
  const page = (data.page || '').trim().slice(0, 200)

  if (data['form-name'] === 'growth-audit') {
    return submitGrowthAudit(env, json, data, name, email, page)
  }

  const company = (data.company || '').trim()
  const message = (data.message || '').trim()
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

function clip(value: unknown, max: number) {
  return String(value ?? '').trim().slice(0, max)
}

// Booked callers complete /growth-audit before the strategy call. Same GHL
// destinations as every other form. The readable message is what Alex sees
// if the workflow has not mapped each custom field.
function submitGrowthAudit(
  env: Env,
  json: (body: unknown, status?: number) => Response,
  data: Record<string, string>,
  name: string,
  email: string,
  page: string,
) {
  if (!email.includes('@') || /\s/.test(email) || email.length > 200 || !name) {
    return json({ ok: false, error: 'Name and a valid work email are required' }, 400)
  }

  const phone = clip(data.phone, 40)
  const company = clip(data.company, 160)
  const website = clip(data.website, 200)
  const sells = clip(data.sells || data.category, 300)
  const offer = clip(data.offer_price, 120)
  const revenue = clip(data.revenue, 80)
  const leads = clip(data.lead_source, 200)
  const budget = clip(data.ad_budget, 80)
  const constraint = clip(data.constraint || data.message, 1000)
  const consent = clip(data.consent, 40)

  if (!phone || !company || !website || !sells || !offer || !revenue || !leads || !budget || !constraint) {
    return json({ ok: false, error: 'Please complete every field' }, 400)
  }
  if (!/^(yes|true|1|on)$/i.test(consent)) {
    return json({ ok: false, error: 'Consent is required' }, 400)
  }

  const fullMessage = [
    'Custom growth audit',
    `Phone: ${phone}`,
    `Website: ${website}`,
    `What they sell: ${sells}`,
    `Offer price: ${offer}`,
    `Monthly revenue: ${revenue}`,
    `Where leads come from: ${leads}`,
    `Ad budget: ${budget}`,
    `Biggest constraint: ${constraint}`,
    'Consent: yes',
  ].join('\n')

  const auditHook = (env.GHL_GROWTH_AUDIT_WEBHOOK_URL || GROWTH_AUDIT_WEBHOOK).trim()
  const n8nHook = (env.N8N_GROWTH_AUDIT_WEBHOOK || N8N_GROWTH_AUDIT_FALLBACK).trim()
  // Include the original form field names as well as the GHL spellings, so EX 16
  // and a GHL mapper can both read every answer, including the consent checkbox.
  // `note` / `notes` / contact.notes are the usual keys for a contact note.
  return forward(env, json, {
    email,
    firstName: name.slice(0, 120),
    name: name.slice(0, 120),
    phone,
    companyName: company,
    website,
    source: 'Custom growth audit',
    tags: ['growth-audit', 'pre-call', 'website-lead'],
    'form-name': 'growth-audit',
    Page: page || '/growth-audit',
    page: page || '/growth-audit',
    sells,
    revenue,
    constraint,
    consent: 'yes',
    offer_price: offer,
    monthly_revenue: revenue,
    ad_budget: budget,
    lead_source: leads,
    what_they_sell: sells,
    biggest_constraint: constraint,
    note: fullMessage,
    notes: fullMessage,
    customField: {
      lead_source_detail: page ? `Growth audit on ${page}` : 'Custom growth audit',
      enquiry_message: fullMessage,
      company,
      phone,
      website,
      offer_price: offer,
      monthly_revenue: revenue,
      lead_source: leads,
      ad_budget: budget,
      biggest_constraint: constraint,
      what_they_sell: sells,
      consent: 'yes',
      notes: fullMessage,
      'contact.notes': fullMessage,
    },
    message: fullMessage,
  }, auditHook && auditHook !== 'off' ? [auditHook] : [], n8nHook && n8nHook !== 'off' ? [n8nHook] : [])
}

// Every form ends here. Set GHL_WEBHOOK_URL in the Cloudflare Pages project to
// change which GHL location receives leads without touching code.
async function forward(
  env: Env,
  json: (body: unknown, status?: number) => Response,
  payload: Record<string, unknown>,
  extraTargets: string[] = [],
  sideChannels: string[] = [],
) {
  // GHL webhook workflows map fields by whatever key the builder picked, so send
  // the common spellings too. Contacts were arriving with no name or company.
  const first = payload.firstName as string | undefined
  const company = payload.companyName as string | undefined
  const phone = typeof payload.phone === 'string' ? payload.phone : undefined
  const body = {
    ...payload,
    first_name: first,
    name: first,
    full_name: first,
    company_name: company,
    company,
    ...(phone ? { phone, phone_number: phone } : {}),
  }
  const base = env.GHL_WEBHOOK_URL
    ? env.GHL_WEBHOOK_URL.split(',').map((u) => u.trim()).filter(Boolean)
    : GHL_FALLBACK
  const targets = [...new Set([...base, ...extraTargets])]
  const post = (url: string) =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.ok)
  const ghlSends = targets.map(post)
  const sideSends = sideChannels.map(post)
  const results = await Promise.allSettled([...ghlSends, ...sideSends])
  const ok = (r: PromiseSettledResult<boolean>) => r.status === 'fulfilled' && r.value === true
  const ghlOk = results.slice(0, ghlSends.length).map(ok)
  const sideOk = results.slice(ghlSends.length).map(ok)
  // How many GHL webhooks and n8n side channels took it, for debugging.
  const delivered: { crm: number; n8n?: number } = { crm: ghlOk.filter(Boolean).length }
  if (sideChannels.length) delivered.n8n = sideOk.filter(Boolean).length
  // The lead is safe as long as one GoHighLevel destination took it. n8n is
  // optional until EX 16 is published, so a missed side channel is not a 502.
  if (ghlOk.some(Boolean)) return json({ ok: true, delivered })
  if (sideOk.some(Boolean)) return json({ ok: true, delivered })
  return json({ ok: false, error: 'Could not deliver the submission', delivered }, 502)
}

