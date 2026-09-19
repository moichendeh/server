// Express 4 does not catch a rejected promise from an async route handler on its own -
// without this, a failed database call would just hang the request instead of
// returning the 500 error page. Wrap every async route handler in this.
module.exports = fn => (req, res, next) => fn(req, res, next).catch(next);
