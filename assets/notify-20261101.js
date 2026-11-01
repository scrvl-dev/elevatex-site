/* Emails every form submission to Alex through FormSubmit, from the visitor's
   browser. (Cloudflare's servers are blocked by FormSubmit, so this cannot run
   in /api/enquiry.) Sent as a simple form post with keepalive, so it survives
   the redirect to the thank you page. GHL still gets the lead via /api/enquiry.
   Files under /assets are cached for a year: ship changes under a new name. */
window.exNotify = function (d) {
  try {
    var f = {
      _subject: 'New website lead: ' + (d.name || d.email || 'website form') + ' (' + (d.form || 'Website form') + ')',
      _template: 'table',
      _captcha: 'false',
      _replyto: d.email || '',
      Form: d.form || '',
      Name: d.name || '',
      Email: d.email || '',
      Company: d.company || '',
      Page: location.pathname,
      Download: d.download || '',
      Details: d.details || ''
    };
    var body = new URLSearchParams();
    Object.keys(f).forEach(function (k) { if (f[k]) body.append(k, f[k]); });
    fetch('https://formsubmit.co/ajax/alex@elevatexsolutions.co.uk', {
      method: 'POST', body: body, keepalive: true, mode: 'cors', headers: { Accept: 'application/json' }
    }).catch(function () {});
  } catch (e) {}
};
