/**
 * Show/Hide button on every password box (portal and rider app), so people can check what they typed before
 * submitting. Attached automatically to any password input that appears, now or later. Accessible: a real button,
 * aria-pressed, and a label that says what it will do. Never changes the value or the autocomplete hints.
 */
export function enablePasswordToggles(root: ParentNode & Node = document.body): () => void {
  const attach = (input: HTMLInputElement) => {
    if (input.dataset.pwToggle) return;
    input.dataset.pwToggle = '1';
    const wrap = document.createElement('span');
    wrap.className = 'pw-wrap';
    input.replaceWith(wrap);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pw-toggle';
    const set = (shown: boolean) => {
      input.type = shown ? 'text' : 'password';
      btn.textContent = shown ? 'Hide' : 'Show';
      btn.setAttribute('aria-pressed', String(shown));
      btn.setAttribute('aria-label', shown ? 'Hide password' : 'Show password');
    };
    btn.addEventListener('click', () => { set(input.type === 'password'); input.focus(); });
    // Hide again when the form is submitted, so a visible password isn't left on screen afterwards.
    input.form?.addEventListener('submit', () => set(false));
    wrap.append(input, btn);
    set(false);
  };
  const scan = (n: ParentNode) => n.querySelectorAll<HTMLInputElement>('input[type=password]:not([data-pw-toggle])').forEach(attach);
  scan(root);
  const obs = new MutationObserver((records) => {
    for (const r of records) r.addedNodes.forEach((n) => {
      if (n instanceof HTMLInputElement && n.type === 'password') attach(n);
      else if (n instanceof Element) scan(n);
    });
  });
  obs.observe(root, { childList: true, subtree: true });
  return () => obs.disconnect();
}
