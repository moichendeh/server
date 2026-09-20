// Admin status comes ONLY from this environment variable - never from "the first
// account", never settable by any user or API call. Set it by hand in Render.
module.exports = function isAdminEmail(email) {
    const list = (process.env.ADMIN_EMAILS || '')
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean);
    return list.includes(String(email || '').toLowerCase());
};
