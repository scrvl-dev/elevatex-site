/**
 * Sends www.elevatexsolutions.co.uk to the apex domain with a 301.
 *
 * The www host was serving every page with a 200, so search engines saw two
 * copies of the site. _redirects cannot match on hostname, so this runs as
 * middleware. _routes.json keeps it off /assets and /brand to save invocations.
 */
export const onRequest: PagesFunction = async ({ request, next }) => {
  const url = new URL(request.url)
  if (url.hostname.startsWith('www.')) {
    url.hostname = url.hostname.slice(4)
    return Response.redirect(url.toString(), 301)
  }
  return next()
}
