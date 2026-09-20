// Cross-site request forgery protection: for anything that changes data, check that
// the request really came from our own page, not from some other website's form or
// script trying to ride the browser's saved login cookie. Browsers always attach the
// "Origin" header themselves on state-changing requests, and a page cannot fake it -
// so if it is present, it must match this site.
//
// Plain page navigations (GET) are exempt - they never change anything, and matter
// for opening links normally.
function csrfProtection(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

    const origin = req.headers.origin;
    if (!origin) return next(); // same-origin requests in some older/plain HTTP clients omit it; Origin is the check when present

    const allowed = `${req.protocol}://${req.headers.host}`;
    if (origin !== allowed) {
        return res.status(403).json({ ok: false, error: 'Request rejected (cross-site request check failed).' });
    }
    next();
}

module.exports = csrfProtection;
