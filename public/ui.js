export function saveToken(t){ localStorage.setItem('fa_token', t); }
export function getToken(){ return localStorage.getItem('fa_token'); }
export function logout(){ localStorage.removeItem('fa_token'); location.href='/login'; }

export async function post(url, body){
  const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body||{}) });
  if (!r.ok) throw new Error((await r.json()).error || 'Request failed');
  return r.json();
}
export async function me(){ return post('/api/me', { token: getToken() }); }

// register SW (and auto-refresh on updates)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    const reg = await navigator.serviceWorker.register('/sw.js');
    reg.addEventListener('updatefound', () => {
      const sw = reg.installing;
      sw?.addEventListener('statechange', () => {
        if (sw.state === 'installed' && navigator.serviceWorker.controller) {
          location.reload();
        }
      });
    });
  });
}
