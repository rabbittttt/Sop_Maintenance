// Install before the deferred application starts so iframe load messages are retained.
window.sopFrameAccount = (() => {
  if (window.parent === window) return null;
  const extraOrigin = document.querySelector('meta[name="sop-parent-origin"]').content;
  let identity = null;
  let resolve;
  const ready = new Promise(done => { resolve = done; });
  window.addEventListener('message', event => {
    if (event.source !== window.parent || (event.origin !== location.origin && event.origin !== extraOrigin)) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || !Object.hasOwn(data, 'account')) return;
    const field = value => typeof value === 'string' ? value.trim() : '';
    const account = field(data.account);
    const roleCode = Number.isSafeInteger(data.roleCode) ? String(data.roleCode) : field(data.roleCode);
    const roleName = field(data.roleName);
    if (identity && (identity.account !== account || identity.roleCode !== roleCode || identity.roleName !== roleName)) {
      // Drop outstanding dialogs, drafts and in-flight callbacks with the old document.
      identity = null;
      location.reload();
      return;
    }
    if (identity || ![account, roleCode, roleName].every(value => value && value.length <= 100 && !/[\x00-\x1f\x7f]/.test(value))) return;
    identity = {account, roleCode, roleName};
    resolve(identity);
  });
  return {ready, get current() { return identity; }};
})();
